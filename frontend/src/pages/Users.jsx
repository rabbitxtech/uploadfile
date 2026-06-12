import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
 Ban,
 Check,
 FolderOpen,
 Gauge,
 KeyRound,
 Pencil,
 Plus,
 ShieldCheck,
 Trash2,
 UserCheck,
 UserMinus,
 UserPlus,
 Users2,
 UserX,
 X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { UserApi, GroupApi } from '../api/endpoints.js';
import { useAuth } from '../store/auth.js';
import { formatBytes, formatDate } from '../lib/format.js';
import { confirmDialog, promptDialog } from '../components/Dialog.jsx';
import ActionMenu from '../components/ActionMenu.jsx';

function gbInput(bytes) {
 return (Number(bytes) / 1024 / 1024 / 1024).toFixed(2);
}

function CreateUserModal({ open, onClose, onCreated }) {
 const [form, setForm] = useState({
 email: '',
 password: '',
 name: '',
 role: 'user',
 quotaGB: '5',
 });
 const [busy, setBusy] = useState(false);

 if (!open) return null;

 const submit = async (e) => {
 e.preventDefault();
 setBusy(true);
 try {
 const quotaBytes = String(Math.round(parseFloat(form.quotaGB || '5') * 1024 * 1024 * 1024));
 await UserApi.create({
 email: form.email,
 password: form.password,
 name: form.name || undefined,
 role: form.role,
 quotaBytes,
 });
 toast.success('User created');
 onCreated?.();
 onClose();
 } catch (err) {
 toast.error(err.response?.data?.error || 'Failed to create user');
 } finally {
 setBusy(false);
 }
 };

 return (
 <div
 className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm animate-[fadeIn_120ms_ease-out]"
 onMouseDown={(e) => {
 if (e.target === e.currentTarget) onClose();
 }}
 >
 <div className="card w-full max-w-md p-5 animate-[popIn_140ms_ease-out]">
 <div className="mb-4 flex items-center justify-between">
 <div className="flex items-center gap-2">
 <UserPlus className="h-5 w-5 text-brand-600 dark:text-brand-400" />
 <span className="font-medium">Create user</span>
 </div>
 <button className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white" onClick={onClose}>
 <X className="h-5 w-5" />
 </button>
 </div>
 <form onSubmit={submit} className="space-y-3">
 <div>
 <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">Username</label>
 <input
 className="input"
 type="text"
 placeholder="letters, digits, . _ - or email"
 required
 minLength={3}
 value={form.email}
 onChange={(e) => setForm({ ...form, email: e.target.value })}
 />
 </div>
 <div>
 <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">Password</label>
 <input
 className="input"
 type="password"
 required
 minLength={6}
 value={form.password}
 onChange={(e) => setForm({ ...form, password: e.target.value })}
 />
 </div>
 <div>
 <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">Name (optional)</label>
 <input
 className="input"
 value={form.name}
 onChange={(e) => setForm({ ...form, name: e.target.value })}
 />
 </div>
 <div className="grid grid-cols-2 gap-3">
 <div>
 <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">Role</label>
 <select
 className="select"
 value={form.role}
 onChange={(e) => setForm({ ...form, role: e.target.value })}
 >
 <option value="user">user</option>
 <option value="admin">admin</option>
 </select>
 </div>
 <div>
 <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">Quota (GB)</label>
 <input
 className="input"
 type="number"
 min="0"
 step="0.1"
 value={form.quotaGB}
 onChange={(e) => setForm({ ...form, quotaGB: e.target.value })}
 />
 </div>
 </div>
 <button type="submit" className="btn-primary w-full justify-center" disabled={busy}>
 <Plus className="h-4 w-4" /> Create user
 </button>
 </form>
 </div>
 </div>
 );
}

export default function Users() {
 const qc = useQueryClient();
 const me = useAuth((s) => s.user);
 const navigate = useNavigate();
 const { data } = useQuery({ queryKey: ['users'], queryFn: () => UserApi.list() });
 const [createOpen, setCreateOpen] = useState(false);

 const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });

 const updateRole = async (u, role) => {
 await UserApi.update(u.id, { role });
 refresh();
 };

 const editName = async (u) => {
 const name = await promptDialog({
 title: 'Edit display name',
 defaultValue: u.name || '',
 placeholder: 'Leave empty to clear',
 confirmText: 'Save',
 });
 if (name === null) return;
 await UserApi.update(u.id, { name: name || undefined });
 toast.success('Name updated');
 refresh();
 };

 const updateQuota = async (u) => {
 const gbs = await promptDialog({
 title: `Update quota for ${u.email}`,
 message: 'Enter the new storage quota in gigabytes.',
 defaultValue: gbInput(u.quotaBytes),
 placeholder: 'e.g. 10',
 confirmText: 'Update',
 variant: 'default',
 });
 if (!gbs) return;
 const bytes = Math.round(parseFloat(gbs) * 1024 * 1024 * 1024);
 await UserApi.update(u.id, { quotaBytes: String(bytes) });
 refresh();
 toast.success('Quota updated');
 };

 const resetPassword = async (u) => {
 const pwd = await promptDialog({
 title: `Set new password for ${u.email}`,
 message: 'The user will need to log in again with the new password.',
 placeholder: 'min 6 characters',
 confirmText: 'Set password',
 });
 if (!pwd) return;
 if (pwd.length < 6) return toast.error('Password too short');
 await UserApi.update(u.id, { password: pwd });
 toast.success('Password updated');
 };

 const toggleBan = async (u) => {
 if (u.banned) {
 await UserApi.update(u.id, { banned: false });
 toast.success(`Unbanned ${u.email}`);
 refresh();
 return;
 }
 const ok = await confirmDialog({
 title: `Ban ${u.email}?`,
 message:
 'Banned users cannot log in or access the API. Their files are kept and access can be restored later.',
 confirmText: 'Ban user',
 });
 if (!ok) return;
 await UserApi.update(u.id, { banned: true });
 toast.success(`Banned ${u.email}`);
 refresh();
 };

 const toggleApprove = async (u) => {
 await UserApi.update(u.id, { approved: !u.approved });
 toast.success(u.approved ? `Approval revoked for ${u.email}` : `Approved ${u.email}`);
 refresh();
 };

 const remove = async (u) => {
 const ok = await confirmDialog({
 title: `Delete user ${u.email}?`,
 message: 'This permanently removes the user and all their files. This cannot be undone.',
 confirmText: 'Delete user',
 });
 if (!ok) return;
 await UserApi.remove(u.id);
 refresh();
 };

 return (
 <div className="p-6">
 <div className="mb-4 flex items-center gap-2">
 <h1 className="text-lg font-semibold">User management</h1>
 <button className="btn-primary ml-auto" onClick={() => setCreateOpen(true)}>
 <UserPlus className="h-4 w-4" /> Create user
 </button>
 </div>
 <div className="card overflow-x-auto">
 <table className="w-full min-w-[720px] text-sm">
 <thead className="bg-slate-50 dark:bg-slate-900/60 text-left text-xs uppercase text-slate-500 dark:text-slate-400">
 <tr>
 <th className="px-3 py-2">Username</th>
 <th className="px-3 py-2">Name</th>
 <th className="px-3 py-2">Role</th>
 <th className="px-3 py-2">Status</th>
 <th className="px-3 py-2">Quota</th>
 <th className="px-3 py-2">Used</th>
 <th className="px-3 py-2">Created</th>
 <th className="px-3 py-2"></th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
 {(data?.users || []).map((u) => {
 const isSelf = u.id === me?.id;
 return (
 <tr
 key={u.id}
 className={
 u.banned
 ? 'bg-red-50/60 dark:bg-red-500/10'
 : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
 }
 >
 <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">
 {u.email}
 {isSelf && <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">(you)</span>}
 </td>
 <td className="px-3 py-2 text-xs">
 <button
 className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
 onClick={() => editName(u)}
 >
 {u.name || <span className="text-slate-400 dark:text-slate-500">—</span>}
 <Pencil className="h-3 w-3 text-slate-400 dark:text-slate-500" />
 </button>
 </td>
 <td className="px-3 py-2 text-xs">
 <select
 className="select-sm"
 value={u.role}
 onChange={(e) => updateRole(u, e.target.value)}
 disabled={isSelf}
 >
 <option value="user">user</option>
 <option value="admin">admin</option>
 </select>
 </td>
 <td className="px-3 py-2 text-xs">
 {u.banned ? (
 <span className="badge bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-300">
 <Ban className="h-3 w-3" /> banned
 </span>
 ) : u.role !== 'admin' && !u.approved ? (
 <span className="badge bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300">
 ⏳ pending
 </span>
 ) : (
 <span className="badge bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-300">
 <Check className="h-3 w-3" /> active
 </span>
 )}
 </td>
 <td className="px-3 py-2 text-xs">{formatBytes(u.quotaBytes)}</td>
 <td className="px-3 py-2 text-xs">{formatBytes(u.usedBytes)}</td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{formatDate(u.createdAt)}</td>
 <td className="px-3 py-2 text-right">
 <div className="flex justify-end">
 <ActionMenu
 label={`Actions for ${u.email}`}
 items={[
 { label: 'Browse files', icon: FolderOpen, onClick: () => navigate(`/files?as=${u.id}`) },
 { label: 'Set quota', icon: Gauge, onClick: () => updateQuota(u) },
 { label: 'Reset password', icon: KeyRound, onClick: () => resetPassword(u) },
 !isSelf && u.role !== 'admin' && {
 label: u.approved ? 'Revoke approval' : 'Approve',
 icon: u.approved ? UserX : UserCheck,
 onClick: () => toggleApprove(u),
 },
 !isSelf && {
 label: u.banned ? 'Unban' : 'Ban',
 icon: u.banned ? Check : Ban,
 danger: !u.banned,
 onClick: () => toggleBan(u),
 },
 !isSelf && { label: 'Delete user', icon: Trash2, danger: true, onClick: () => remove(u) },
 ]}
 />
 </div>
 </td>
 </tr>
 );
 })}
 {!(data?.users || []).length && (
 <tr>
 <td colSpan={8} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">
 No users yet
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
 <ShieldCheck className="mr-1 inline h-3.5 w-3.5 align-text-bottom" />
 Self-registered users start as <strong>pending</strong> and must be approved before they can upload. Banned users cannot log in or access the API; their files are preserved.
 </div>
 <GroupsCard />
 <CreateUserModal
 open={createOpen}
 onClose={() => setCreateOpen(false)}
 onCreated={refresh}
 />
 </div>
 );
}

// Task5 #14 — teams: share a file/folder to a whole group at once. Admins
// create groups and manage membership here; the ShareModal picks them up.
function GroupsCard() {
 const qc = useQueryClient();
 const { data } = useQuery({ queryKey: ['groups'], queryFn: () => GroupApi.list() });
 const groups = data?.groups || [];
 const [newName, setNewName] = useState('');
 const [memberInput, setMemberInput] = useState({}); // groupId -> identifier

 const refresh = () => qc.invalidateQueries({ queryKey: ['groups'] });

 const create = async (e) => {
 e.preventDefault();
 if (!newName.trim()) return;
 try {
 await GroupApi.create(newName.trim());
 setNewName('');
 refresh();
 toast.success('Group created');
 } catch (err) {
 toast.error(err.response?.data?.error || 'Failed to create group');
 }
 };

 const rename = async (g) => {
 const name = await promptDialog({
 title: 'Rename group',
 defaultValue: g.name,
 confirmText: 'Rename',
 });
 if (!name || name === g.name) return;
 try {
 await GroupApi.rename(g.id, name);
 refresh();
 } catch (err) {
 toast.error(err.response?.data?.error || 'Failed to rename');
 }
 };

 const remove = async (g) => {
 const ok = await confirmDialog({
 title: `Delete group "${g.name}"?`,
 message: 'Members lose access to everything shared with this group.',
 confirmText: 'Delete group',
 });
 if (!ok) return;
 await GroupApi.remove(g.id);
 refresh();
 };

 const addMember = async (e, g) => {
 e.preventDefault();
 const identifier = (memberInput[g.id] || '').trim();
 if (!identifier) return;
 try {
 await GroupApi.addMember(g.id, identifier);
 setMemberInput((m) => ({ ...m, [g.id]: '' }));
 refresh();
 toast.success(`Added ${identifier}`);
 } catch (err) {
 toast.error(err.response?.data?.error || 'Failed to add member');
 }
 };

 const removeMember = async (g, u) => {
 await GroupApi.removeMember(g.id, u.id);
 refresh();
 };

 return (
 <div className="mt-6">
 <div className="mb-3 flex items-center gap-2">
 <Users2 className="h-5 w-5 text-brand-600 dark:text-brand-400" />
 <h2 className="text-base font-semibold">Groups</h2>
 </div>
 <div className="card p-4">
 <form onSubmit={create} className="mb-4 flex gap-2">
 <input
 className="input max-w-xs"
 placeholder="New group name"
 value={newName}
 maxLength={80}
 onChange={(e) => setNewName(e.target.value)}
 />
 <button type="submit" className="btn-primary shrink-0">
 <Plus className="h-4 w-4" /> Create group
 </button>
 </form>
 {groups.length === 0 && (
 <div className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">
 No groups yet. Create one to share files with a whole team at once.
 </div>
 )}
 <div className="space-y-4">
 {groups.map((g) => (
 <div key={g.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
 <div className="mb-2 flex items-center gap-2">
 <span className="font-medium text-slate-900 dark:text-slate-100">{g.name}</span>
 <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
 {g.memberCount} member{g.memberCount === 1 ? '' : 's'}
 </span>
 <div className="ml-auto flex gap-1">
 <button
 className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
 onClick={() => rename(g)}
 title="Rename group"
 >
 <Pencil className="h-3.5 w-3.5" />
 </button>
 <button
 className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800"
 onClick={() => remove(g)}
 title="Delete group"
 >
 <Trash2 className="h-3.5 w-3.5" />
 </button>
 </div>
 </div>
 <div className="mb-2 flex flex-wrap gap-1.5">
 {(g.members || []).map((u) => (
 <span
 key={u.id}
 className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200"
 >
 {u.name || u.email}
 <button
 onClick={() => removeMember(g, u)}
 className="text-slate-400 hover:text-red-600"
 title="Remove from group"
 aria-label={`Remove ${u.email} from ${g.name}`}
 >
 <UserMinus className="h-3 w-3" />
 </button>
 </span>
 ))}
 {(g.members || []).length === 0 && (
 <span className="text-xs text-slate-400 dark:text-slate-500">No members yet</span>
 )}
 </div>
 <form onSubmit={(e) => addMember(e, g)} className="flex gap-2">
 <input
 className="input max-w-xs"
 placeholder="Add member by username or email"
 value={memberInput[g.id] || ''}
 onChange={(e) => setMemberInput((m) => ({ ...m, [g.id]: e.target.value }))}
 />
 <button type="submit" className="btn-secondary shrink-0">
 <UserPlus className="h-4 w-4" /> Add
 </button>
 </form>
 </div>
 ))}
 </div>
 </div>
 </div>
 );
}
