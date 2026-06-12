import { useEffect, useState } from 'react';
import {
  X,
  Copy,
  Check,
  Folder as FolderIcon,
  File as FileIcon,
  Link as LinkIcon,
  UserPlus,
  Users2,
  Trash2,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import QRCode from 'qrcode';
import { ShareApi, GrantApi, GroupApi } from '../api/endpoints.js';
import { copyText } from '../lib/uid.js';

export default function ShareModal({ target, onClose }) {
  const [tab, setTab] = useState('user'); // 'user' | 'link'
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [maxDownloads, setMaxDownloads] = useState('');
  const [allowUpload, setAllowUpload] = useState(false);
  const [share, setShare] = useState(null);
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState(null); // data-URL of the link QR (Task5 #15)

  // internal user-share state
  const [granteeType, setGranteeType] = useState('user'); // 'user' | 'group'
  const [identifier, setIdentifier] = useState('');
  const [groupId, setGroupId] = useState('');
  const [permission, setPermission] = useState('view');
  const qc = useQueryClient();

  useEffect(() => {
    // reset when target changes
    setShare(null);
    setIdentifier('');
    setGroupId('');
    setGranteeType('user');
    setLabel('');
    setPassword('');
    setExpiresAt('');
    setMaxDownloads('');
    setAllowUpload(false);
    setQr(null);
  }, [target]);

  const isFolder = !!target?.folderId;
  const resourceParams = target
    ? target.fileId
      ? { fileId: target.fileId }
      : { folderId: target.folderId }
    : null;

  const grantsQuery = useQuery({
    queryKey: ['grants', target?.fileId || target?.folderId],
    queryFn: () => GrantApi.list(resourceParams),
    enabled: !!target && tab === 'user',
  });
  const groupsQuery = useQuery({
    queryKey: ['groups'],
    queryFn: () => GroupApi.list(),
    enabled: !!target && tab === 'user',
  });
  const groups = groupsQuery.data?.groups || [];

  // Render the QR for the created link (scan-to-open for someone next to you).
  useEffect(() => {
    if (!share) return;
    QRCode.toDataURL(`${window.location.origin}/s/${share.token}`, { width: 220, margin: 1 })
      .then(setQr)
      .catch(() => setQr(null));
  }, [share]);

  if (!target) return null;

  const subjectName = target.name || (isFolder ? 'this folder' : 'this file');

  const submitLink = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...resourceParams };
      if (label.trim()) payload.label = label.trim();
      if (password) payload.password = password;
      if (expiresAt) payload.expiresAt = new Date(expiresAt).toISOString();
      if (maxDownloads) payload.maxDownloads = parseInt(maxDownloads, 10);
      if (isFolder && allowUpload) payload.allowUpload = true;
      const s = await ShareApi.create(payload);
      setShare(s);
      qc.invalidateQueries({ queryKey: ['shares'] });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create share');
    }
  };

  const submitGrant = async (e) => {
    e.preventDefault();
    try {
      if (granteeType === 'group') {
        if (!groupId) return;
        await GrantApi.create({ ...resourceParams, groupId, permission });
        toast.success(`Shared with group ${groups.find((g) => g.id === groupId)?.name || ''}`);
      } else {
        if (!identifier.trim()) return;
        await GrantApi.create({ ...resourceParams, identifier: identifier.trim(), permission });
        toast.success(`Shared with ${identifier.trim()}`);
        setIdentifier('');
      }
      qc.invalidateQueries({ queryKey: ['grants', target.fileId || target.folderId] });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to share');
    }
  };

  const revoke = async (g) => {
    try {
      if (target.fileId) await GrantApi.removeFile(g.id);
      else await GrantApi.removeFolder(g.id);
      qc.invalidateQueries({ queryKey: ['grants', target.fileId || target.folderId] });
    } catch (err) {
      toast.error('Failed to revoke');
    }
  };

  const url = share ? `${window.location.origin}/s/${share.token}` : '';
  const copy = async () => {
    await copyText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const TabBtn = ({ id, icon: Icon, children }) => (
    <button
      onClick={() => setTab(id)}
      className={clsx(
        'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition',
        tab === id
          ? 'bg-brand-600 text-white'
          : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
      )}
    >
      <Icon className="h-4 w-4" /> {children}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-md p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
            {isFolder ? (
              <FolderIcon className="h-4 w-4 shrink-0 text-amber-500" />
            ) : (
              <FileIcon className="h-4 w-4 shrink-0 text-brand-600 dark:text-brand-400" />
            )}
            <span className="truncate">Share — {subjectName}</span>
          </div>
          <button
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white"
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
          <TabBtn id="user" icon={UserPlus}>
            With a user
          </TabBtn>
          <TabBtn id="link" icon={LinkIcon}>
            Public link
          </TabBtn>
        </div>

        {tab === 'user' ? (
          <div className="space-y-3">
            <form onSubmit={submitGrant} className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="block text-xs text-slate-500 dark:text-slate-400">
                  {granteeType === 'group' ? 'Group' : 'Username or email'}
                </label>
                {groups.length > 0 && (
                  <div className="flex gap-1 text-[11px]">
                    {['user', 'group'].map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setGranteeType(t)}
                        className={clsx(
                          'rounded px-1.5 py-0.5 capitalize',
                          granteeType === t
                            ? 'bg-brand-600 text-white'
                            : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
                        )}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                {granteeType === 'group' ? (
                  <select
                    className="select flex-1"
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                  >
                    <option value="">Select a group…</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name} ({g.memberCount})
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input"
                    placeholder="e.g. alice"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                  />
                )}
                <select
                  className="select-sm w-24 shrink-0"
                  value={permission}
                  onChange={(e) => setPermission(e.target.value)}
                >
                  <option value="view">View</option>
                  <option value="edit">Edit</option>
                </select>
              </div>
              <button type="submit" className="btn-primary w-full justify-center">
                {granteeType === 'group' ? <Users2 className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />} Share
              </button>
            </form>

            <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
              <div className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                People with access
              </div>
              <div className="max-h-48 space-y-1 overflow-auto">
                {(grantsQuery.data?.grants || []).map((g) => (
                  <div
                    key={g.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 truncate text-sm text-slate-800 dark:text-slate-200">
                        {g.group && <Users2 className="h-3.5 w-3.5 shrink-0 text-brand-500" />}
                        {g.group ? g.group.name : g.user?.name || g.user?.email}
                      </div>
                      {g.user?.name && (
                        <div className="truncate text-xs text-slate-400 dark:text-slate-500">
                          {g.user.email}
                        </div>
                      )}
                      {g.group && (
                        <div className="truncate text-xs text-slate-400 dark:text-slate-500">
                          group
                        </div>
                      )}
                    </div>
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                      {g.permission}
                    </span>
                    <button
                      onClick={() => revoke(g)}
                      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-700"
                      title="Revoke"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                {(grantsQuery.data?.grants || []).length === 0 && (
                  <div className="py-2 text-center text-xs text-slate-400 dark:text-slate-500">
                    Not shared with anyone yet
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : !share ? (
          <form onSubmit={submitLink} className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                Label (optional — only you see it)
              </label>
              <input
                className="input"
                value={label}
                maxLength={120}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. for the design team"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                Password (optional)
              </label>
              <input
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                placeholder="leave empty for no password"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                Expires at (optional)
              </label>
              <input
                className="input"
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
                Max downloads (optional)
              </label>
              <input
                className="input"
                type="number"
                min="1"
                value={maxDownloads}
                onChange={(e) => setMaxDownloads(e.target.value)}
              />
            </div>
            {isFolder && (
              <>
                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 px-3 py-2 dark:border-slate-700">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={allowUpload}
                    onChange={(e) => setAllowUpload(e.target.checked)}
                  />
                  <span className="text-xs text-slate-600 dark:text-slate-300">
                    <span className="font-medium text-slate-800 dark:text-slate-100">Allow uploads</span>
                    <br />
                    Visitors (no account needed) can upload files into this folder. Uploads count
                    against your quota.
                  </span>
                </label>
                <div className="rounded-md bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                  Anyone with this link can list and download the folder as a ZIP
                  {allowUpload ? ', and upload files into it' : ''}.
                </div>
              </>
            )}
            <button type="submit" className="btn-primary w-full justify-center">
              Create link
            </button>
          </form>
        ) : (
          <div>
            <div className="mb-2 text-xs text-slate-500 dark:text-slate-400">
              Anyone with this link can access:
            </div>
            <div className="flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-2">
              <code className="flex-1 truncate text-xs">{url}</code>
              <button
                onClick={copy}
                className="rounded p-1 hover:bg-slate-200 dark:hover:bg-slate-800"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-600" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            </div>
            {qr && (
              <div className="mt-3 flex justify-center">
                <img
                  src={qr}
                  alt="QR code for the share link"
                  className="rounded-md border border-slate-200 bg-white p-1 dark:border-slate-700"
                  width={160}
                  height={160}
                />
              </div>
            )}
            <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              {share.label ? `"${share.label}". ` : ''}
              {share.password ? 'Password protected. ' : ''}
              {share.expiresAt ? `Expires ${new Date(share.expiresAt).toLocaleString()}. ` : ''}
              {share.maxDownloads ? `Max ${share.maxDownloads} downloads.` : ''}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
