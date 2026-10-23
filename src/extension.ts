import * as vscode from 'vscode';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out']);
const MAX_SIZE = 200 * 1024; // skip files bigger than 200 KB

// An item in the basket is either a whole file or a highlighted snippet.
type Item =
  | { kind: 'file'; uri: vscode.Uri }
  | { kind: 'snippet'; label: string; text: string };

// The tree view: holds the list and tells VS Code how to draw each row.
class BasketProvider implements vscode.TreeDataProvider<Item> {
  items: Item[] = [];
  private _change = new vscode.EventEmitter<void>();
  onDidChangeTreeData = this._change.event;

  refresh() {
    this._change.fire();
  }

  getChildren(): Item[] {
    return this.items;
  }

  getTreeItem(item: Item): vscode.TreeItem {
    if (item.kind === 'file') {
      const rel = vscode.workspace.asRelativePath(item.uri, false);
      const ti = new vscode.TreeItem(item.uri); // gives the file-type icon
      ti.description = rel.includes('/') ? rel.substring(0, rel.lastIndexOf('/')) : '';
      ti.tooltip = rel;
      ti.command = { command: 'vscode.open', title: 'Open', arguments: [item.uri] };
      return ti;
    }
    const ti = new vscode.TreeItem(item.label);
    ti.iconPath = new vscode.ThemeIcon('code');
    ti.tooltip = item.text.slice(0, 300);
    return ti;
  }
}

// If a folder is added, collect every file inside it.
async function collectFiles(uri: vscode.Uri, out: vscode.Uri[]) {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type & vscode.FileType.Directory) {
    for (const [name] of await vscode.workspace.fs.readDirectory(uri)) {
      if (IGNORED.has(name)) continue;
      await collectFiles(vscode.Uri.joinPath(uri, name), out);
    }
  } else if (stat.type & vscode.FileType.File) {
    out.push(uri);
  }
}

// Read every item and build the merged text. Returns undefined if nothing is readable.
async function buildText(items: Item[]) {
  if (items.length === 0) {
    vscode.window.showWarningMessage('Basket is empty.');
    return undefined;
  }
  const parts: string[] = [];
  let skipped = 0;

  for (const item of items) {
    if (item.kind === 'snippet') {
      parts.push(`=== ${item.label} ===\n${item.text}\n`);
      continue;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(item.uri);
      // skip big files and binary files (binary files contain a 0 byte)
      if (bytes.length > MAX_SIZE || bytes.includes(0)) {
        skipped++;
        continue;
      }
      const rel = vscode.workspace.asRelativePath(item.uri, false);
      parts.push(`=== ${rel} ===\n${Buffer.from(bytes).toString('utf8')}\n`);
    } catch {
      skipped++; // file was deleted or unreadable
    }
  }

  if (parts.length === 0) {
    vscode.window.showWarningMessage('Nothing readable to merge.');
    return undefined;
  }
  const text = parts.join('\n');
  const summary =
    `${parts.length} item(s), ~${Math.round(text.length / 4)} tokens` +
    (skipped ? `, skipped ${skipped}` : '');
  return { text, summary };
}

// Fallback: the block under a header line is every following line that is indented deeper.
function indentationFoldEnd(doc: vscode.TextDocument, startLine: number): number | undefined {
  const indent = (n: number) => {
    const t = doc.lineAt(n).text;
    return t.trim() === '' ? -1 : t.length - t.trimStart().length; // -1 = blank line
  };
  const base = indent(startLine);
  if (base < 0) return undefined;

  let end = startLine;
  for (let i = startLine + 1; i < doc.lineCount; i++) {
    const ind = indent(i);
    if (ind === -1) continue; // blank lines don't end the block
    if (ind <= base) break;   // back to the same or lower indent: block is over
    end = i;
  }
  return end > startLine ? end : undefined;
}

// If the selection ends on a collapsed fold header, return the real last line of that block.
async function expandFolded(editor: vscode.TextEditor, lastLine: number): Promise<number> {
  const ranges =
    (await vscode.commands.executeCommand<vscode.FoldingRange[]>(
      'vscode.executeFoldingRangeProvider',
      editor.document.uri
    )) ?? [];

  // the fold that starts exactly on our last selected line,
  // or an indentation-based guess if the language has no folding provider
  const fold = ranges.find((r) => r.start === lastLine && r.end > lastLine);
  const foldEnd = fold ? fold.end : indentationFoldEnd(editor.document, lastLine);
  if (foldEnd === undefined) return lastLine;

  // is it really collapsed? then the line after the header is not visible
  const nextLine = lastLine + 1;
  const vr = editor.visibleRanges;
  if (vr.length === 0) return lastLine;
  const viewportEnd = vr[vr.length - 1].end.line;
  if (nextLine > viewportEnd) return lastLine; // header at the bottom edge, can't tell
  const collapsed = !vr.some((r) => r.start.line <= nextLine && nextLine <= r.end.line);
  if (!collapsed) return lastLine;

  let end = foldEnd;
  // for brace languages the fold usually stops before the closing "}", so include it
  const next = end + 1;
  if (
    next < editor.document.lineCount &&
    /^\s*[}\])]+[;,]?\s*$/.test(editor.document.lineAt(next).text)
  ) {
    end = next;
  }
  return end;
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new BasketProvider();
  const view = vscode.window.createTreeView('mergeFiles.basket', {
    treeDataProvider: provider,
    canSelectMany: true,
  });

  // Update the list and the little number badge on the panel icon.
  const update = () => {
    provider.refresh();
    const n = provider.items.length;
    view.badge = n ? { value: n, tooltip: `${n} item(s) in basket` } : undefined;
  };

  // Add files / folders (from Explorer, or the current editor file)
  const addFiles = vscode.commands.registerCommand(
    'mergeFiles.addFiles',
    async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
      let uris = (selected && selected.length ? selected : [clicked]).filter(
        (u): u is vscode.Uri => !!u
      );
      if (uris.length === 0 && vscode.window.activeTextEditor) {
        uris = [vscode.window.activeTextEditor.document.uri];
      }
      const files: vscode.Uri[] = [];
      for (const u of uris) await collectFiles(u, files);

      const have = new Set(
        provider.items.filter((i) => i.kind === 'file').map((i) => (i as any).uri.toString())
      );
      let added = 0;
      for (const f of files) {
        if (have.has(f.toString())) continue; // no duplicates
        provider.items.push({ kind: 'file', uri: f });
        added++;
      }
      update();
      vscode.window.setStatusBarMessage(`Added ${added} file(s) to basket`, 2500);
    }
  );

  // Add highlighted code (includes the hidden lines if the selection is a folded block)
  const addSelection = vscode.commands.registerCommand('mergeFiles.addSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) return;
    const sel = editor.selection;

    // last line actually included in the selection (0-based)
    let lastLine =
      sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;

    const expanded = await expandFolded(editor, lastLine);
    let text: string;
    if (expanded !== lastLine) {
      const range = new vscode.Range(
        new vscode.Position(sel.start.line, 0),
        editor.document.lineAt(expanded).range.end
      );
      text = editor.document.getText(range);
      lastLine = expanded;
    } else {
      text = editor.document.getText(sel);
    }

    const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
    provider.items.push({
      kind: 'snippet',
      label: `${rel} (lines ${sel.start.line + 1}-${lastLine + 1})`,
      text,
    });
    update();
  });

  // Remove one or more selected rows
  const remove = vscode.commands.registerCommand(
    'mergeFiles.remove',
    (item?: Item, all?: Item[]) => {
      const toRemove = new Set<Item>(all && all.length ? all : item ? [item] : []);
      provider.items = provider.items.filter((i) => !toRemove.has(i));
      update();
    }
  );

  // Empty the basket
  const clear = vscode.commands.registerCommand('mergeFiles.clear', () => {
    provider.items = [];
    update();
  });

  // Copy merged text to the clipboard
  const copy = vscode.commands.registerCommand('mergeFiles.copy', async () => {
    const result = await buildText(provider.items);
    if (!result) return;
    await vscode.env.clipboard.writeText(result.text);
    vscode.window.showInformationMessage(`Copied to clipboard: ${result.summary}`);
  });

  // Save merged text to a file
  const save = vscode.commands.registerCommand('mergeFiles.save', async () => {
    const result = await buildText(provider.items);
    if (!result) return;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, 'merged.txt') : undefined,
    });
    if (!target) return; // you cancelled the dialog
    await vscode.workspace.fs.writeFile(target, Buffer.from(result.text, 'utf8'));
    vscode.window.showInformationMessage(`Saved: ${result.summary}`);
  });

  context.subscriptions.push(view, addFiles, addSelection, remove, clear, copy, save);
}

export function deactivate() { }