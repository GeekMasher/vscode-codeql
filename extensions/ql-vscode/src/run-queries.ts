import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as tmp from 'tmp';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { ErrorCodes, ResponseError } from 'vscode-languageclient';

import * as cli from './cli';
import { DatabaseItem, getUpgradesDirectories } from './databases';
import * as helpers from './helpers';
import { DatabaseInfo, QueryMetadata, ResultsPaths } from './interface-types';
import { logger } from './logging';
import * as messages from './messages';
import { QueryHistoryItemOptions } from './query-history';
import * as qsClient from './queryserver-client';
import { isQuickQueryPath } from './quick-query';
import { upgradeDatabase } from './upgrades';

/**
 * run-queries.ts
 * -------------
 *
 * Compiling and running QL queries.
 */

// XXX: Tmp directory should be configuarble.
export const tmpDir = tmp.dirSync({ prefix: 'queries_', keep: false, unsafeCleanup: true });
export const upgradesTmpDir = tmp.dirSync({ dir: tmpDir.name, prefix: 'upgrades_', keep: false, unsafeCleanup: true });
export const tmpDirDisposal = {
  dispose: () => {
    upgradesTmpDir.removeCallback();
    tmpDir.removeCallback();
  }
};

export class UserCancellationException extends Error { }

/**
 * A collection of evaluation-time information about a query,
 * including the query itself, and where we have decided to put
 * temporary files associated with it, such as the compiled query
 * output and results.
 */
export class QueryInfo {
  private static nextQueryId = 0;

  readonly compiledQueryPath: string;
  readonly resultsPaths: ResultsPaths;
  readonly dataset: vscode.Uri; // guarantee the existence of a well-defined dataset dir at this point
  readonly queryID: number;

  constructor(
    public readonly program: messages.QlProgram,
    public readonly dbItem: DatabaseItem,
    public readonly queryDbscheme: string, // the dbscheme file the query expects, based on library path resolution
    public readonly quickEvalPosition?: messages.Position,
    public readonly metadata?: QueryMetadata,
    public readonly templates?: messages.TemplateDefinitions,
  ) {
    this.queryID = QueryInfo.nextQueryId++;
    this.compiledQueryPath = path.join(tmpDir.name, `compiledQuery${this.queryID}.qlo`);
    this.resultsPaths = {
      resultsPath: path.join(tmpDir.name, `results${this.queryID}.bqrs`),
      interpretedResultsPath: path.join(tmpDir.name, `interpretedResults${this.queryID}.sarif`),
    };
    if (dbItem.contents === undefined) {
      throw new Error('Can\'t run query on invalid database.');
    }
    this.dataset = dbItem.contents.datasetUri;
  }

  async run(
    qs: qsClient.QueryServerClient,
  ): Promise<messages.EvaluationResult> {
    let result: messages.EvaluationResult | null = null;

    const callbackId = qs.registerCallback(res => { result = res });

    const queryToRun: messages.QueryToRun = {
      resultsPath: this.resultsPaths.resultsPath,
      qlo: vscode.Uri.file(this.compiledQueryPath).toString(),
      allowUnknownTemplates: true,
      templateValues: this.templates,
      id: callbackId,
      timeoutSecs: qs.config.timeoutSecs,
    }
    const dataset: messages.Dataset = {
      dbDir: this.dataset.fsPath,
      workingSet: 'default'
    }
    const params: messages.EvaluateQueriesParams = {
      db: dataset,
      evaluateId: callbackId,
      queries: [queryToRun],
      stopOnError: false,
      useSequenceHint: false
    }
    try {
      await helpers.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Running Query",
        cancellable: true,
      }, (progress, token) => {
        return qs.sendRequest(messages.runQueries, params, token, progress)
      });
    } finally {
      qs.unRegisterCallback(callbackId);
    }
    return result || {
      evaluationTime: 0,
      message: "No result from server",
      queryId: -1,
      runId: callbackId,
      resultType: messages.QueryResultType.OTHER_ERROR
    };
  }

  async compile(
    qs: qsClient.QueryServerClient,
  ): Promise<messages.CompilationMessage[]> {
    let compiled: messages.CheckQueryResult | undefined;
    try {
      const params: messages.CompileQueryParams = {
        compilationOptions: {
          computeNoLocationUrls: true,
          failOnWarnings: false,
          fastCompilation: false,
          includeDilInQlo: true,
          localChecking: false,
          noComputeGetUrl: false,
          noComputeToString: false,
        },
        extraOptions: {
          timeoutSecs: qs.config.timeoutSecs
        },
        queryToCheck: this.program,
        resultPath: this.compiledQueryPath,
        target: this.quickEvalPosition ? {
          quickEval: { quickEvalPos: this.quickEvalPosition }
        } : {
           query: {}
        }
      };


      compiled = await helpers.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Compiling Query",
        cancellable: true,
      }, (progress, token) => {
        return qs.sendRequest(messages.compileQuery, params, token, progress);
      });
    } finally {
      qs.logger.log(" - - - COMPILATION DONE - - - ");
    }
    return (compiled?.messages || []).filter(msg => msg.severity === messages.Severity.ERROR);
  }

  /**
   * Holds if this query should produce interpreted results.
   */
  async hasInterpretedResults(): Promise<boolean> {
    const hasMetadataFile = await this.dbItem.hasMetadataFile();
    if (!hasMetadataFile) {
      logger.log("Cannot produce interpreted results since the database does not have a .dbinfo or codeql-database.yml file.");
    }
    return hasMetadataFile;
  }
}

export interface QueryWithResults {
  readonly query: QueryInfo;
  readonly result: messages.EvaluationResult;
  readonly database: DatabaseInfo;
  readonly options: QueryHistoryItemOptions;
}

export async function clearCacheInDatabase(qs: qsClient.QueryServerClient, dbItem: DatabaseItem):
  Promise<messages.ClearCacheResult> {
  if (dbItem.contents === undefined) {
    throw new Error('Can\'t clear the cache in an invalid database.');
  }

  const db: messages.Dataset = {
    dbDir: dbItem.contents.datasetUri.fsPath,
    workingSet: 'default',
  };

  const params: messages.ClearCacheParams = {
    dryRun: false,
    db,
  };

  return helpers.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Clearing Cache",
    cancellable: false,
  }, (progress, token) =>
    qs.sendRequest(messages.clearCache, params, token, progress)
  );
}

/**
 *
 * @param filePath This needs to be equivalent to java Path.toRealPath(NO_FOLLOW_LINKS)
 *
 */
async function convertToQlPath(filePath: string): Promise<string> {
  if (process.platform === "win32") {

    if (path.parse(filePath).root === filePath) {
      // Java assumes uppercase drive letters are canonical.
      return filePath.toUpperCase();
    } else {
      const dir = await convertToQlPath(path.dirname(filePath));
      const fileName = path.basename(filePath);
      const fileNames = await promisify<string, string[]>(fs.readdir)(dir);
      for (const name of fileNames) {
        if (fileName.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0) {
          return path.join(dir, name);
        }
      }
    }
    throw new Error("Can't convert path to form suitable for QL:" + filePath);
  } else {
    return filePath;
  }
}



/** Gets the selected position within the given editor. */
async function getSelectedPosition(editor: vscode.TextEditor): Promise<messages.Position> {
  const pos = editor.selection.start;
  const posEnd = editor.selection.end;
  // Convert from 0-based to 1-based line and column numbers.
  return {
    fileName: await convertToQlPath(editor.document.fileName),
    line: pos.line + 1, column: pos.character + 1,
    endLine: posEnd.line + 1, endColumn: posEnd.character + 1
  };
}

/**
 * Compare the dbscheme implied by the query `query` and that of the current database.
 * If they are compatible, do nothing.
 * If they are incompatible but the database can be upgraded, suggest that upgrade.
 * If they are incompatible and the database cannot be upgraded, throw an error.
 */
async function checkDbschemeCompatibility(
  cliServer: cli.CodeQLCliServer,
  qs: qsClient.QueryServerClient,
  query: QueryInfo
): Promise<void> {
  const searchPath = helpers.getOnDiskWorkspaceFolders();

  if (query.dbItem.contents !== undefined && query.dbItem.contents.dbSchemeUri !== undefined) {
    const { scripts, finalDbscheme } = await cliServer.resolveUpgrades(query.dbItem.contents.dbSchemeUri.fsPath, searchPath);
    const hash = async function (filename: string): Promise<string> {
      return crypto.createHash('sha256').update(await fs.readFile(filename)).digest('hex');
    }

    // At this point, we have learned about three dbschemes:

    // query.program.dbschemePath is the dbscheme of the actual
    // database we're querying.
    const dbschemeOfDb = await hash(query.program.dbschemePath);

    // query.queryDbScheme is the dbscheme of the query we're
    // running, including the library we've resolved it to use.
    const dbschemeOfLib = await hash(query.queryDbscheme);

    // info.finalDbscheme is which database we're able to upgrade to
    const upgradableTo = await hash(finalDbscheme);

    if (upgradableTo != dbschemeOfLib) {
      logger.log(`Query ${query.program.queryPath} expects database scheme ${query.queryDbscheme}, but database has scheme ${query.program.dbschemePath}, and no upgrade path found`);
      throw new Error(`Query ${query.program.queryPath} expects database scheme ${query.queryDbscheme}, but the current database has a different scheme, and no database upgrades are available. The current database scheme may be newer than the CodeQL query libraries in your workspace. Please try using a newer version of the query libraries.`);
    }

    if (upgradableTo == dbschemeOfLib &&
      dbschemeOfDb != dbschemeOfLib) {
      // Try to upgrade the database
      await upgradeDatabase(
        qs,
        query.dbItem,
        vscode.Uri.file(finalDbscheme),
        getUpgradesDirectories(scripts)
      );
    }
  }
}

/** Prompts the user to save `document` if it has unsaved changes. */
async function promptUserToSaveChanges(document: vscode.TextDocument): Promise<void> {
  if (document.isDirty) {
    // TODO: add 'always save' button which records preference in configuration
    if (await helpers.showBinaryChoiceDialog('Query file has unsaved changes. Save now?')) {
      await document.save();
    }
  }
}

type SelectedQuery = {
  queryPath: string;
  quickEvalPosition?: messages.Position;
};

/**
 * Determines which QL file to run during an invocation of `Run Query` or `Quick Evaluation`, as follows:
 * - If the command was called by clicking on a file, then use that file.
 * - Otherwise, use the file open in the current editor.
 * - In either case, prompt the user to save the file if it is open with unsaved changes.
 * - For `Quick Evaluation`, ensure the selected file is also the one open in the editor,
 * and use the selected region.
 * @param selectedResourceUri The selected resource when the command was run.
 * @param quickEval Whether the command being run is `Quick Evaluation`.
*/
export async function determineSelectedQuery(selectedResourceUri: vscode.Uri | undefined, quickEval: boolean): Promise<SelectedQuery> {
  const editor = vscode.window.activeTextEditor;

  // Choose which QL file to use.
  let queryUri: vscode.Uri;
  if (selectedResourceUri === undefined) {
    // No resource was passed to the command handler, so obtain it from the active editor.
    // This usually happens when the command is called from the Command Palette.
    if (editor === undefined) {
      throw new Error('No query was selected. Please select a query and try again.');
    } else {
      queryUri = editor.document.uri;
    }
  } else {
    // A resource was passed to the command handler, so use it.
    queryUri = selectedResourceUri;
  }

  if (queryUri.scheme !== 'file') {
    throw new Error('Can only run queries that are on disk.');
  }
  const queryPath = queryUri.fsPath || '';

  if (quickEval) {
    if (!(queryPath.endsWith('.ql') || queryPath.endsWith('.qll'))) {
      throw new Error('The selected resource is not a CodeQL file; It should have the extension ".ql" or ".qll".');
    }
  }
  else {
    if (!(queryPath.endsWith('.ql'))) {
      throw new Error('The selected resource is not a CodeQL query file; It should have the extension ".ql".');
    }
  }

  // Whether we chose the file from the active editor or from a context menu,
  // if the same file is open with unsaved changes in the active editor,
  // then prompt the user to save it first.
  if (editor !== undefined && editor.document.uri.fsPath === queryPath) {
    await promptUserToSaveChanges(editor.document);
  }

  let quickEvalPosition: messages.Position | undefined = undefined;
  if (quickEval) {
    if (editor == undefined) {
      throw new Error('Can\'t run quick evaluation without an active editor.');
    }
    if (editor.document.fileName !== queryPath) {
      // For Quick Evaluation we expect these to be the same.
      // Report an error if we end up in this (hopefully unlikely) situation.
      throw new Error('The selected resource for quick evaluation should match the active editor.');
    }
    quickEvalPosition = await getSelectedPosition(editor);
  }

  return { queryPath, quickEvalPosition };
}

export async function compileAndRunQueryAgainstDatabase(
  cliServer: cli.CodeQLCliServer,
  qs: qsClient.QueryServerClient,
  db: DatabaseItem,
  quickEval: boolean,
  selectedQueryUri: vscode.Uri | undefined,
  templates?: messages.TemplateDefinitions,
): Promise<QueryWithResults> {

  if (!db.contents || !db.contents.dbSchemeUri) {
    throw new Error(`Database ${db.databaseUri} does not have a CodeQL database scheme.`);
  }

  // Determine which query to run, based on the selection and the active editor.
  const { queryPath, quickEvalPosition } = await determineSelectedQuery(selectedQueryUri, quickEval);

  // If this is quick query, store the query text
  const historyItemOptions: QueryHistoryItemOptions = {};
  if (isQuickQueryPath(queryPath)) {
    historyItemOptions.queryText = await fs.readFile(queryPath, 'utf8');
  }

  // Get the workspace folder paths.
  const diskWorkspaceFolders = helpers.getOnDiskWorkspaceFolders();
  // Figure out the library path for the query.
  const packConfig = await cliServer.resolveLibraryPath(diskWorkspaceFolders, queryPath);

  // Check whether the query has an entirely different schema from the
  // database. (Queries that merely need the database to be upgraded
  // won't trigger this check)
  // This test will produce confusing results if we ever change the name of the database schema files.
  const querySchemaName = path.basename(packConfig.dbscheme);
  const dbSchemaName = path.basename(db.contents.dbSchemeUri.fsPath);
  if (querySchemaName != dbSchemaName) {
    logger.log(`Query schema was ${querySchemaName}, but database schema was ${dbSchemaName}.`);
    throw new Error(`The query ${path.basename(queryPath)} cannot be run against the selected database: their target languages are different. Please select a different database and try again.`);
  }

  const qlProgram: messages.QlProgram = {
    // The project of the current document determines which library path
    // we use. The `libraryPath` field in this server message is relative
    // to the workspace root, not to the project root.
    libraryPath: packConfig.libraryPath,
    // Since we are compiling and running a query against a database,
    // we use the database's DB scheme here instead of the DB scheme
    // from the current document's project.
    dbschemePath: db.contents.dbSchemeUri.fsPath,
    queryPath: queryPath
  };

  // Read the query metadata if possible, to use in the UI.
  let metadata: QueryMetadata | undefined;
  try {
    metadata = await cliServer.resolveMetadata(qlProgram.queryPath);
  } catch (e) {
    // Ignore errors and provide no metadata.
    logger.log(`Couldn't resolve metadata for ${qlProgram.queryPath}: ${e}`);
  }

  const query = new QueryInfo(qlProgram, db, packConfig.dbscheme, quickEvalPosition, metadata, templates);
  await checkDbschemeCompatibility(cliServer, qs, query);

  let errors;
  try {
    errors = await query.compile(qs);
  } catch (e) {
    if (e instanceof ResponseError && e.code == ErrorCodes.RequestCancelled) {
      return createSyntheticResult(query, db, historyItemOptions, 'Query cancelled', messages.QueryResultType.CANCELLATION);
    } else {
      throw e;
    }
  }

  if (errors.length == 0) {
    const result = await query.run(qs);
    if (result.resultType !== messages.QueryResultType.SUCCESS) {
      const message = result.message || 'Failed to run query';
      logger.log(message);
      helpers.showAndLogErrorMessage(message);
    }
    return {
      query,
      result,
      database: {
        name: db.name,
        databaseUri: db.databaseUri.toString(true)
      },
      options: historyItemOptions
    };
  } else {
    // Error dialogs are limited in size and scrollability,
    // so we include a general description of the problem,
    // and direct the user to the output window for the detailed compilation messages.
    // However we don't show quick eval errors there so we need to display them anyway.
    qs.logger.log(`Failed to compile query ${query.program.queryPath} against database scheme ${query.program.dbschemePath}:`);

    const formattedMessages: string[] = [];

    for (const error of errors) {
      const message = error.message || "[no error message available]";
      const formatted = `ERROR: ${message} (${error.position.fileName}:${error.position.line}:${error.position.column}:${error.position.endLine}:${error.position.endColumn})`;
      formattedMessages.push(formatted);
      qs.logger.log(formatted);
    }
    if (quickEval && formattedMessages.length <= 3) {
      helpers.showAndLogErrorMessage("Quick evaluation compilation failed: \n" + formattedMessages.join("\n"));
    } else {
      helpers.showAndLogErrorMessage((quickEval ? "Quick evaluation" : "Query") +
        " compilation failed. Please make sure there are no errors in the query, the database is up to date," +
        " and the query and database use the same target language. For more details on the error, go to View > Output," +
        " and choose CodeQL Query Server from the dropdown.");
    }

    return createSyntheticResult(query, db, historyItemOptions, 'Query had compilation errors', messages.QueryResultType.OTHER_ERROR);
  }
}

function createSyntheticResult(
  query: QueryInfo,
  db: DatabaseItem,
  historyItemOptions: QueryHistoryItemOptions,
  message: string,
  resultType: number
): QueryWithResults {

  return {
    query,
    result: {
      evaluationTime: 0,
      resultType: resultType,
      queryId: -1,
      runId: -1,
      message
    },
    database: {
      name: db.name,
      databaseUri: db.databaseUri.toString(true)
    },
    options: historyItemOptions,
  };
}
