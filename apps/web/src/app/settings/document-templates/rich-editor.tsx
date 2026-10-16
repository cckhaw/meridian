'use client';
import { useEffect, useRef } from 'react';

/**
 * A small rich-text editor over the safe subset the server keeps (headings, paragraphs, emphasis, lists, quotes, rules, alignment). It edits real HTML in a
 * contentEditable box; whatever is pasted is reduced to plain text, and the server cleans the result again on save, so nothing here has to be trusted.
 * `document.execCommand` is old but is still what every browser offers for this, and it keeps the editor free of a large dependency.
 */
export interface EditorApi { insertText: (t: string) => void }
const run = (cmd: string, arg?: string) => { document.execCommand(cmd, false, arg); };
const Btn = ({ label, title, onClick, wide }: { label: string; title: string; onClick: () => void; wide?: boolean }) => (
  <button type="button" title={title} aria-label={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
    className={`min-h-[36px] ${wide ? 'px-3' : 'w-9'} rounded-control border border-separator bg-surface text-footnote font-semibold hover:border-accent`}>{label}</button>
);

export function RichEditor({ value, onChange, resetKey, readOnly, apiRef }: { value: string; onChange: (html: string) => void; resetKey: string; readOnly?: boolean; apiRef?: { current: EditorApi | null } }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.innerHTML = value; }, [resetKey]);   // eslint-disable-line react-hooks/exhaustive-deps -- load once per document; edits stay in the box
  useEffect(() => { if (apiRef) apiRef.current = { insertText: (t) => { ref.current?.focus(); run('insertText', t); onChange(ref.current?.innerHTML ?? ''); } }; });
  const emit = () => onChange(ref.current?.innerHTML ?? '');
  const block = (tag: string) => () => { run('formatBlock', tag); emit(); };
  const cmd = (c: string) => () => { run(c); emit(); };
  return (
    <div className="rounded-control border border-separator bg-surface">
      {!readOnly && (
        <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-1 border-b border-separator p-2">
          <Btn label="H1" title="Title" onClick={block('h1')} /><Btn label="H2" title="Heading" onClick={block('h2')} /><Btn label="H3" title="Sub-heading" onClick={block('h3')} /><Btn label="¶" title="Paragraph" onClick={block('p')} />
          <span className="mx-1 h-5 w-px bg-separator" />
          <Btn label="B" title="Bold" onClick={cmd('bold')} /><Btn label="I" title="Italic" onClick={cmd('italic')} /><Btn label="U" title="Underline" onClick={cmd('underline')} />
          <span className="mx-1 h-5 w-px bg-separator" />
          <Btn label="• List" title="Bulleted list" wide onClick={cmd('insertUnorderedList')} /><Btn label="1. List" title="Numbered list" wide onClick={cmd('insertOrderedList')} /><Btn label="❝" title="Quote" onClick={block('blockquote')} /><Btn label="—" title="Dividing line" onClick={cmd('insertHorizontalRule')} />
          <span className="mx-1 h-5 w-px bg-separator" />
          <Btn label="⇤" title="Align left" onClick={cmd('justifyLeft')} /><Btn label="⇔" title="Centre" onClick={cmd('justifyCenter')} /><Btn label="⇥" title="Align right" onClick={cmd('justifyRight')} />
          <Btn label="Clear" title="Remove formatting" wide onClick={cmd('removeFormat')} />
        </div>
      )}
      <div ref={ref} contentEditable={!readOnly} suppressContentEditableWarning role="textbox" aria-multiline aria-label="Agreement text" spellCheck
        onInput={emit} onBlur={emit}
        onPaste={(e) => { e.preventDefault(); run('insertText', e.clipboardData.getData('text/plain')); emit(); }}
        className="min-h-[360px] max-h-[70vh] overflow-auto p-4 text-body focus-visible:outline-none [&_blockquote]:border-l-4 [&_blockquote]:border-separator [&_blockquote]:pl-3 [&_blockquote]:text-label2 [&_h1]:mb-2 [&_h1]:text-title2 [&_h1]:font-bold [&_h2]:mb-1 [&_h2]:mt-4 [&_h2]:text-title3 [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_hr]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-6 [&_table]:w-full [&_td]:border [&_td]:border-separator [&_td]:p-1 [&_th]:border [&_th]:border-separator [&_th]:p-1" />
    </div>
  );
}
