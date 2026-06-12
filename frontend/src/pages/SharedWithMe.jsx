import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Folder as FolderIcon,
  File as FileIcon,
  Image as ImageIcon,
  FileText,
  FileArchive,
  Music,
  Video,
} from 'lucide-react';
import { GrantApi, FileApi } from '../api/endpoints.js';
import { formatBytes, formatDate, fileIcon } from '../lib/format.js';
import PreviewModal from '../components/PreviewModal.jsx';

const ICONS = {
  image: ImageIcon,
  video: Video,
  audio: Music,
  pdf: FileText,
  archive: FileArchive,
  file: FileIcon,
};

function PermBadge({ permission }) {
  return (
    <span
      className={
        'badge ' +
        (permission === 'edit'
          ? 'bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300'
          : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300')
      }
    >
      {permission}
    </span>
  );
}

export default function SharedWithMe() {
  const navigate = useNavigate();
  const [preview, setPreview] = useState(null);
  const { data, isLoading } = useQuery({
    queryKey: ['shared-with-me'],
    queryFn: () => GrantApi.sharedWithMe(),
  });

  const folders = data?.folders || [];
  const files = data?.files || [];
  const empty = !isLoading && folders.length === 0 && files.length === 0;

  return (
    <div className="p-4 md:p-6">
      <h1 className="mb-4 text-lg font-semibold">Shared with me</h1>

      {empty && (
        <div className="card p-8 text-center text-sm text-slate-500 dark:text-slate-400">
          Nothing has been shared with you yet.
        </div>
      )}

      {folders.length > 0 && (
        <>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Folders
          </div>
          <div className="mb-6 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {folders.map((f) => (
              <button
                key={f.id}
                onClick={() => navigate(`/files/${f.id}`)}
                className="card flex items-center gap-3 p-3 text-left transition hover:border-brand-500"
              >
                <FolderIcon className="h-6 w-6 shrink-0 text-amber-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-900 dark:text-slate-100">
                    {f.name}
                  </div>
                  <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                    from {f.owner?.name || f.owner?.email}
                    {f.viaGroup ? ` · via group "${f.viaGroup}"` : ''}
                  </div>
                </div>
                <PermBadge permission={f.permission} />
              </button>
            ))}
          </div>
        </>
      )}

      {files.length > 0 && (
        <>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Files
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Owner</th>
                  <th className="px-3 py-2">Access</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">Shared</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {files.map((f) => {
                  const Icon = ICONS[fileIcon(f.mimeType)] || FileIcon;
                  return (
                    <tr
                      key={f.id}
                      className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                      onClick={() => setPreview(f)}
                    >
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Icon className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" />
                          <span className="truncate font-medium text-slate-900 dark:text-slate-100">
                            {f.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                        {f.owner?.name || f.owner?.email}
                        {f.viaGroup && (
                          <span className="ml-1 text-slate-400 dark:text-slate-500">
                            · via "{f.viaGroup}"
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <PermBadge permission={f.permission} />
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                        {formatBytes(f.size)}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                        {formatDate(f.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <PreviewModal
        file={preview}
        onClose={() => setPreview(null)}
        siblings={files}
        onNavigate={setPreview}
      />
    </div>
  );
}
