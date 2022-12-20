import {
  QuickPickItem,
  TreeView,
  TreeViewExpansionEvent,
  window,
  workspace,
} from "vscode";
import { commandRunner, UserCancellationException } from "../../commandRunner";
import {
  getNwoFromGitHubUrl,
  isValidGitHubNwo,
  getOwnerFromGitHubUrl,
  isValidGitHubOwner,
} from "../../common/github-url-identifier-helper";
import { DisposableObject } from "../../pure/disposable-object";
import { DbItem, DbItemKind } from "../db-item";
import { DbManager } from "../db-manager";
import { DbTreeDataProvider } from "./db-tree-data-provider";
import { DbTreeViewItem } from "./db-tree-view-item";

interface RemoteDatabaseQuickPickItem extends QuickPickItem {
  kind: string;
}

export class DbPanel extends DisposableObject {
  private readonly dataProvider: DbTreeDataProvider;
  private readonly treeView: TreeView<DbTreeViewItem>;

  public constructor(private readonly dbManager: DbManager) {
    super();

    this.dataProvider = new DbTreeDataProvider(dbManager);

    this.treeView = window.createTreeView("codeQLDatabasesExperimental", {
      treeDataProvider: this.dataProvider,
      canSelectMany: false,
    });

    this.push(
      this.treeView.onDidCollapseElement(async (e) => {
        await this.onDidCollapseElement(e);
      }),
    );
    this.push(
      this.treeView.onDidExpandElement(async (e) => {
        await this.onDidExpandElement(e);
      }),
    );

    this.push(this.treeView);
  }

  public async initialize(): Promise<void> {
    this.push(
      commandRunner("codeQLDatabasesExperimental.openConfigFile", () =>
        this.openConfigFile(),
      ),
    );
    this.push(
      commandRunner("codeQLDatabasesExperimental.addNewDatabase", () =>
        this.addNewRemoteDatabase(),
      ),
    );
    this.push(
      commandRunner("codeQLDatabasesExperimental.addNewList", () =>
        this.addNewList(),
      ),
    );
    this.push(
      commandRunner(
        "codeQLDatabasesExperimental.setSelectedItem",
        (treeViewItem: DbTreeViewItem) => this.setSelectedItem(treeViewItem),
      ),
    );
  }

  private async openConfigFile(): Promise<void> {
    const configPath = this.dbManager.getConfigPath();
    const document = await workspace.openTextDocument(configPath);
    await window.showTextDocument(document);
  }

  private async addNewRemoteDatabase(): Promise<void> {
    const quickPickItems = [
      {
        label: "$(repo) From a GitHub repository",
        detail: "Add a remote repository from GitHub",
        alwaysShow: true,
        kind: "repo",
      },
      {
        label: "$(organization) All repositories of a GitHub org or owner",
        detail:
          "Add a remote list of repositories from a GitHub organization/owner",
        alwaysShow: true,
        kind: "owner",
      },
    ];
    const databaseKind =
      await window.showQuickPick<RemoteDatabaseQuickPickItem>(quickPickItems, {
        title: "Add a remote repository",
        placeHolder: "Select an option",
        ignoreFocusOut: true,
      });
    if (!databaseKind) {
      // We don't need to display a warning pop-up in this case, since the user just escaped out of the operation.
      // We set 'true' to make this a silent exception.
      throw new UserCancellationException("No repository selected", true);
    }
    if (databaseKind.kind === "repo") {
      await this.addNewRemoteRepo();
    } else if (databaseKind.kind === "owner") {
      await this.addNewRemoteOwner();
    }
  }

  private async addNewRemoteRepo(): Promise<void> {
    const repoName = await window.showInputBox({
      title: "Add a remote repository",
      prompt: "Insert a GitHub repository URL or name with owner",
      placeHolder: "github.com/<owner>/<repo> or <owner>/<repo>",
    });
    if (!repoName) {
      return;
    }

    const nwo = getNwoFromGitHubUrl(repoName) || repoName;
    if (!isValidGitHubNwo(nwo)) {
      throw new Error(`Invalid GitHub repository: ${repoName}`);
    }

    await this.dbManager.addNewRemoteRepo(nwo);
  }

  private async addNewRemoteOwner(): Promise<void> {
    const ownerName = await window.showInputBox({
      title: "Add all repositories of a GitHub org or owner",
      prompt: "Insert a GitHub organization or owner name",
      placeHolder: "github.com/<owner> or <owner>",
    });

    if (!ownerName) {
      return;
    }

    const owner = getOwnerFromGitHubUrl(ownerName) || ownerName;
    if (!isValidGitHubOwner(owner)) {
      throw new Error(`Invalid user or organization: ${owner}`);
    }

    await this.dbManager.addNewRemoteOwner(owner);
  }

  private async addNewList(): Promise<void> {
    const listName = await window.showInputBox({
      prompt: "Enter a name for the new list",
      placeHolder: "example-list",
    });
    if (listName === undefined) {
      return;
    }

    const highlightedItem = await this.getHighlightedDbItem();

    // For now: we only support adding remote lists, so if no item is highlighted,
    // we default to the "RootRemote" kind.
    // In future: if the highlighted item is undefined, we'll show a quick pick where
    // a user can select whether to add a remote or local list.
    const listKind = highlightedItem?.kind || DbItemKind.RootRemote;

    await this.dbManager.addNewList(listKind, listName);
  }

  private async setSelectedItem(treeViewItem: DbTreeViewItem): Promise<void> {
    if (treeViewItem.dbItem === undefined) {
      throw new Error(
        "Not a selectable database item. Please select a valid item.",
      );
    }
    await this.dbManager.setSelectedDbItem(treeViewItem.dbItem);
  }

  private async onDidCollapseElement(
    event: TreeViewExpansionEvent<DbTreeViewItem>,
  ): Promise<void> {
    const dbItem = event.element.dbItem;
    if (!dbItem) {
      throw Error("Expected a database item.");
    }

    await this.dbManager.updateDbItemExpandedState(event.element.dbItem, false);
  }

  private async onDidExpandElement(
    event: TreeViewExpansionEvent<DbTreeViewItem>,
  ): Promise<void> {
    const dbItem = event.element.dbItem;
    if (!dbItem) {
      throw Error("Expected a database item.");
    }

    await this.dbManager.updateDbItemExpandedState(event.element.dbItem, true);
  }

  /**
   * Gets the currently highlighted database item in the tree view.
   * The VS Code API calls this the "selection", but we already have a notion of selection
   * (i.e. which item has a check mark next to it), so we call this "highlighted".
   *
   * @returns The highlighted database item, or `undefined` if no item is highlighted.
   */
  private async getHighlightedDbItem(): Promise<DbItem | undefined> {
    // You can only select one item at a time, so selection[0] gives the selection
    return this.treeView.selection[0]?.dbItem;
  }
}
