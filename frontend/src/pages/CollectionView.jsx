import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Search as SearchIcon, FolderHeart, X, Play } from 'lucide-react';
import { CollectionApi } from '../api/endpoints.js';
import { api } from '../api/client.js';
import { formatBytes } from '../lib/format.js';
import PreviewModal from '../components/PreviewModal.jsx';

function ThumbCard({ file, onPreview, onRemove }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    let blob;
    if (file.hasPreview) {
      api
        .get(`/files/${file.id}/thumbnail`, { responseType: 'blob' })
        .then((r) => {
          if (!alive) return;
          blob = URL.createObjectURL(r.data);
          setUrl(blob);
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
      if (blob) URL.revokeObjectURL(blob);
    };
  }, [file.id, file.hasPreview]);

  return (
    <div className="group relative overflow-hidden rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <button onClick={() => onPreview(file)} className="block w-full text-left">
        <div className="relative flex aspect-square items-center justify-center bg-slate-100 dark:bg-slate-800">
          {url ? (
            <img src={url} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="px-2 text-center text-xs text-slate-400">{file.mimeType}</span>
          )}
          {(file.mimeType || '').startsWith('video/') && (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 ring-1 ring-white/30">
                <Play className="h-4 w-4 translate-x-0.5 text-white" fill="currentColor" />
              </span>
            </span>
          )}
        </div>
        <div className="truncate px-2 py-1 text-xs font-medium text-slate-900 dark:text-slate-100">{file.name}</div>
        <div className="px-2 pb-1 text-[10px] text-slate-400">{formatBytes(file.size)}</div>
      </button>
      {onRemove && (
        <button
          onClick={() => onRemove(file)}
          className="absolute right-1 top-1 rounded-full bg-black/55 p-1 text-white opacity-0 hover:bg-red-600 group-hover:opacity-100"
          title="Remove from collection"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export default function CollectionView() {
  const { id } = useParams();
  const qc = useQueryClient();
  const [preview, setPreview] = useState(null);
  const { data, isLoading } = useQuery({
    queryKey: ['collection', id],
    queryFn: () => CollectionApi.get(id),
  });

  const removeFile = async (file) => {
    await CollectionApi.removeFile(id, file.id);
    qc.invalidateQueries({ queryKey: ['collection', id] });
    qc.invalidateQueries({ queryKey: ['collections'] });
  };

  if (isLoading) return <div className="p-6 text-sm text-slate-500 dark:text-slate-400">Loading…</div>;
  if (!data) return <div className="p-6 text-sm text-red-500">Collection not found</div>;

  const files = data.files || [];
  const isSmart = data.kind === 'smart';

  return (
    <div className="p-6">
      <div className="mb-1 flex items-center gap-2">
        <Link to="/collections" className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        {isSmart ? <SearchIcon className="h-5 w-5 text-brand-500" /> : <FolderHeart className="h-5 w-5 text-brand-500" />}
        <h1 className="text-lg font-semibold">{data.name}</h1>
        <span className="text-sm text-slate-400">· {files.length} file{files.length === 1 ? '' : 's'}</span>
      </div>
      <div className="mb-5 text-xs text-slate-500 dark:text-slate-400">
        {isSmart
          ? `Smart collection — live results for ${[
              data.filter?.q && `“${data.filter.q}”`,
              data.filter?.tag && `tag:${data.filter.tag}`,
            ]
              .filter(Boolean)
              .join(' · ') || 'all files'}`
          : 'Manual collection'}
      </div>

      {files.length === 0 ? (
        <div className="card p-12 text-center text-slate-500 dark:text-slate-400">
          {isSmart ? 'No files match this search yet.' : 'Empty — add files from the file list (“Add to collection”).'}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {files.map((f) => (
            <ThumbCard key={f.id} file={f} onPreview={setPreview} onRemove={isSmart ? null : removeFile} />
          ))}
        </div>
      )}

      <PreviewModal file={preview} onClose={() => setPreview(null)} siblings={files} onNavigate={setPreview} />
    </div>
  );
}
