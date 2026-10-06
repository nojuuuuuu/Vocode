import { basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';

export function createCodeEditor(parent, onChange, onCursor) {
  const languageMode = new Compartment();
  const editability = new Compartment();
  let replacing = false;
  let languageRequest = 0;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      extensions: [
        basicSetup,
        oneDark,
        keymap.of([indentWithTab]),
        EditorView.theme({
          '&': { height: '100%', backgroundColor: '#171f28', color: '#d9e7e5', fontSize: '12px' },
          '.cm-scroller': { fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', lineHeight: '24px' },
          '.cm-content': { padding: '10px 0 25px' },
          '.cm-gutters': { backgroundColor: '#171f28', border: 'none', color: '#526271', paddingLeft: '9px' },
          '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#24313b' },
          '.cm-cursor': { borderLeftColor: '#8deac1' },
          '.cm-selectionBackground': { backgroundColor: '#456c5e !important' }
        }, { dark: true }),
        EditorView.contentAttributes.of({ 'aria-label': 'コードエディタ', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
        languageMode.of([]),
        editability.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !replacing) onChange(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) onCursor();
        })
      ]
    })
  });

  return {
    get value() { return view.state.doc.toString(); },
    get position() {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { row: line.number, column: head - line.from + 1 };
    },
    setValue(content) {
      replacing = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        selection: { anchor: 0 },
        effects: EditorView.scrollIntoView(0, { y: 'start' })
      });
      view.scrollDOM.scrollTop = 0;
      view.scrollDOM.scrollLeft = 0;
      replacing = false;
    },
    setEnabled(enabled) {
      view.dispatch({ effects: editability.reconfigure([
        EditorState.readOnly.of(!enabled), EditorView.editable.of(enabled)
      ]) });
    },
    async setLanguage(filename) {
      const request = ++languageRequest;
      const description = filename && LanguageDescription.matchFilename(languages, filename);
      const support = description ? await description.load() : [];
      if (request === languageRequest) view.dispatch({ effects: languageMode.reconfigure(support) });
    },
    focus() { view.focus(); }
  };
}
