import * as vscode from "vscode";

/**
 * Empty tree data provider for the BC Artifacts sidebar view.
 * Returns no items so VS Code renders the viewsWelcome content,
 * which contains the "Open BC Artifacts Explorer" button.
 */
export class ArtifactsLauncherProvider implements vscode.TreeDataProvider<never> {
    getTreeItem(): vscode.TreeItem {
        return new vscode.TreeItem("");
    }

    getChildren(): never[] {
        return [];
    }
}
