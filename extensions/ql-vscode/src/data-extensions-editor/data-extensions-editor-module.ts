import { ExtensionContext } from "vscode";
import { DataExtensionsEditorView } from "./data-extensions-editor-view";
import { DataExtensionsEditorCommands } from "../common/commands";
import { CodeQLCliServer } from "../cli";
import { QueryRunner } from "../queryRunner";
import { DatabaseManager } from "../local-databases";
import { extLogger } from "../common";
import { ensureDir } from "fs-extra";
import { join } from "path";

export class DataExtensionsEditorModule {
  private readonly queryStorageDir: string;

  private constructor(
    private readonly ctx: ExtensionContext,
    private readonly databaseManager: DatabaseManager,
    private readonly cliServer: CodeQLCliServer,
    private readonly queryRunner: QueryRunner,
    baseQueryStorageDir: string,
  ) {
    this.queryStorageDir = join(
      baseQueryStorageDir,
      "data-extensions-editor-results",
    );
  }

  public static async initialize(
    ctx: ExtensionContext,
    databaseManager: DatabaseManager,
    cliServer: CodeQLCliServer,
    queryRunner: QueryRunner,
    queryStorageDir: string,
  ): Promise<DataExtensionsEditorModule> {
    const dataExtensionsEditorModule = new DataExtensionsEditorModule(
      ctx,
      databaseManager,
      cliServer,
      queryRunner,
      queryStorageDir,
    );

    await dataExtensionsEditorModule.initialize();
    return dataExtensionsEditorModule;
  }

  public getCommands(): DataExtensionsEditorCommands {
    return {
      "codeQL.openDataExtensionsEditor": async () => {
        const db = this.databaseManager.currentDatabaseItem;
        if (!db) {
          void extLogger.log("No database selected");
          return;
        }

        const view = new DataExtensionsEditorView(
          this.ctx,
          this.cliServer,
          this.queryRunner,
          this.queryStorageDir,
          db,
        );
        await view.openView();
      },
    };
  }

  private async initialize(): Promise<void> {
    await ensureDir(this.queryStorageDir);
  }
}