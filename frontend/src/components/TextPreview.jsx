import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';
import { api } from '../api/client.js';

// Map common code extensions to highlight.js language ids.
const CODE_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', json: 'json', html: 'xml', htm: 'xml',
  xml: 'xml', svg: 'xml', css: 'css', scss: 'scss', less: 'less',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml',
  sql: 'sql', swift: 'swift', dart: 'dart', toml: 'ini', ini: 'ini',
  dockerfile: 'dockerfile', makefile: 'makefile', vue: 'xml',
};

export default function TextPreview({ file }) {
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    api
      .get(`/files/${file.id}/preview`, { responseType: 'text' })
      .then((r) => {
        if (cancelled) return;
        setText(typeof r.data === 'string' ? r.data : String(r.data ?? ''));
      })
      .catch(() => !cancelled && setError('Failed to load file'));
    return () => {
      cancelled = true;
    };
  }, [file.id]);

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const isMarkdown = ext === 'md' || ext === 'markdown' || file.mimeType === 'text/markdown';

  const rendered = useMemo(() => {
    if (text == null) return null;
    if (isMarkdown) {
      const raw = marked.parse(text, { breaks: true, gfm: true });
      return { html: DOMPurify.sanitize(raw) };
    }
    const lang = CODE_LANG[ext];
    try {
      const out = lang
        ? hljs.highlight(text, { language: lang }).value
        : hljs.highlightAuto(text).value;
      return { code: out };
    } catch {
      return { code: null };
    }
  }, [text, isMarkdown, ext]);

  if (error) return <div className="p-12 text-center text-red-500">{error}</div>;
  if (text == null)
    return <div className="p-12 text-center text-slate-500 dark:text-slate-400">Loading…</div>;

  if (isMarkdown) {
    return (
      <div className="mx-auto max-h-[72vh] w-full max-w-3xl overflow-auto rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="md-body" dangerouslySetInnerHTML={{ __html: rendered.html }} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-h-[72vh] w-full max-w-4xl overflow-auto rounded-lg border border-slate-800 bg-[#282c34] text-sm shadow-inner">
      <pre className="m-0 p-4">
        <code
          className="hljs block whitespace-pre font-mono leading-relaxed"
          dangerouslySetInnerHTML={{
            __html: rendered.code ?? text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])),
          }}
        />
      </pre>
    </div>
  );
}
