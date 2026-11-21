import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Youtube from '@tiptap/extension-youtube';
import { TableKit } from '@tiptap/extension-table';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import { CharacterCount, Placeholder } from '@tiptap/extensions';
import { ImageFigure } from './image-figure';
import { Embed } from './embed';

export { ImageFigure } from './image-figure';
export { Embed, resolveEmbed, safeHttpsUrl } from './embed';
export { cleanPastedHtml } from './paste';

/** Ngôn ngữ cho khối mã (class language-xxx, highlight phía storefront nếu cần) */
export const CODE_LANGUAGES: { value: string; label: string }[] = [
  { value: 'plaintext', label: 'Văn bản thuần' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'json', label: 'JSON' },
  { value: 'bash', label: 'Bash / Shell' },
  { value: 'php', label: 'PHP' },
  { value: 'python', label: 'Python' },
  { value: 'sql', label: 'SQL' },
  { value: 'java', label: 'Java' },
  { value: 'csharp', label: 'C#' },
  { value: 'go', label: 'Go' },
  { value: 'yaml', label: 'YAML' },
  { value: 'markdown', label: 'Markdown' },
];

export function buildExtensions({ placeholder, compact }: { placeholder: string; compact?: boolean }) {
  return [
    StarterKit.configure({
      heading: { levels: compact ? [2, 3, 4] : [1, 2, 3, 4] },
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https', HTMLAttributes: { target: null, rel: null } },
      codeBlock: { languageClassPrefix: 'language-', defaultLanguage: null },
    }),
    ImageFigure,
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
    Youtube.configure({ nocookie: true, width: 720, height: 405 }),
    TableKit.configure({ table: { resizable: true, lastColumnResizable: false } }),
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
    Embed,
    CharacterCount,
    Placeholder.configure({ placeholder }),
  ];
}
