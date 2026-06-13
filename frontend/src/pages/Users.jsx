import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation, Trans } from 'react-i18next';
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
 const { t } = useTranslation();
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
 toast.success(t('users.userCreated'));
 onCreated?.();
 onClose();
 } catch (err) {
 toast.error(err.response?.data?.error || t('users.createFailed'));
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
 <span className="font-medium">{t('users.createUser')}</span>
 </div>
 <button className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-white" onClick={onClose}>
 <X className="h-5 w-5" />
 </button>
 </div>
 <form onSubmit={submit} className="space-y-3">
 <div>
 <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">{t('profile.username')}</label>
 <input
 className="input"
 type="text"
 placeholder={t('users.usernameHint')}
 required
 minLength={3}
 value={form.email}
 onChange={(e) => setForm({ ...form, email: e.target.value })}
 />
 </div>
 <div>
 <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">{t('auth.password')}</label>
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
 <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">{t('users.nameOptional')}</label>
 <input
 className="input"
 value={form.name}
 onChange={(e) => setForm({ ...form, name: e.target.value })}
 />
 </div>
 <div className="grid grid-cols-2 gap-3">
 <div>
 <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">{t('users.role')}</label>
 <select
 className="select"
 value={form.role}
 onChange={(e) => setForm({ ...form, role: e.target.value })}
 >
 <option value="user">{t('users.roleUser')}</option>
 <option value="admin">{t('users.roleAdmin')}</option>
 </select>
 </div>
 <div>
 <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">{t('users.quotaGB')}</label>
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
 <Plus className="h-4 w-4" /> {t('users.createUser')}
 </button>
 </form>
 </div>
 </div>
 );
}

export default function Users() {
 const { t } = useTranslation();
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
 title: t('users.editName'),
 defaultValue: u.name || '',
 placeholder: t('users.leaveEmptyClear'),
 confirmText: t('common.save'),
 });
 if (name === null) return;
 await UserApi.update(u.id, { name: name || undefined });
 toast.success(t('users.nameUpdated'));
 refresh();
 };

 const updateQuota = async (u) => {
 const gbs = await promptDialog({
 title: t('users.updateQuotaTitle', { email: u.email }),
 message: t('users.updateQuotaMsg'),
 defaultValue: gbInput(u.quotaBytes),
 placeholder: t('users.egTen'),
 confirmText: t('users.update'),
 variant: 'default',
 });
 if (!gbs) return;
 const bytes = Math.round(parseFloat(gbs) * 1024 * 1024 * 1024);
 await UserApi.update(u.id, { quotaBytes: String(bytes) });
 refresh();
 toast.success(t('users.quotaUpdated'));
 };

 const resetPassword = async (u) => {
 const pwd = await promptDialog({
 title: t('users.setPwTitle', { email: u.email }),
 message: t('users.setPwMsg'),
 placeholder: t('users.min6'),
 confirmText: t('users.setPassword'),
 });
 if (!pwd) return;
 if (pwd.length < 6) return toast.error(t('users.pwTooShort'));
 await UserApi.update(u.id, { password: pwd });
 toast.success(t('users.pwUpdated'));
 };

 const toggleBan = async (u) => {
 if (u.banned) {
 await UserApi.update(u.id, { banned: false });
 toast.success(t('users.unbannedToast', { email: u.email }));
 refresh();
 return;
 }
 const ok = await confirmDialog({
 title: t('users.banTitle', { email: u.email }),
 message: t('users.banMsg'),
 confirmText: t('users.banUser'),
 });
 if (!ok) return;
 await UserApi.update(u.id, { banned: true });
 toast.success(t('users.bannedToast', { email: u.email }));
 refresh();
 };

 const toggleApprove = async (u) => {
 await UserApi.update(u.id, { approved: !u.approved });
 toast.success(u.approved ? t('users.approveRevoked', { email: u.email }) : t('users.approvedToast', { email: u.email }));
 refresh();
 };

 const remove = async (u) => {
 const ok = await confirmDialog({
 title: t('users.deleteTitle', { email: u.email }),
 message: t('users.deleteMsg'),
 confirmText: t('users.deleteUser'),
 });
 if (!ok) return;
 await UserApi.remove(u.id);
 refresh();
 };

 return (
 <div className="p-6">
 <div className="mb-4 flex items-center gap-2">
 <h1 className="text-lg font-semibold">{t('users.title')}</h1>
 <button className="btn-primary ml-auto" onClick={() => setCreateOpen(true)}>
 <UserPlus className="h-4 w-4" /> {t('users.createUser')}
 </button>
 </div>
 <div className="card overflow-x-auto">
 <table className="w-full min-w-[720px] text-sm">
 <thead className="bg-slate-50 dark:bg-slate-900/60 text-left text-xs uppercase text-slate-500 dark:text-slate-400">
 <tr>
 <th className="px-3 py-2">{t('profile.username')}</th>
 <th className="px-3 py-2">{t('files.sort.name')}</th>
 <th className="px-3 py-2">{t('users.thRole')}</th>
 <th className="px-3 py-2">{t('users.thStatus')}</th>
 <th className="px-3 py-2">{t('users.thQuota')}</th>
 <th className="px-3 py-2">{t('users.thUsed')}</th>
 <th className="px-3 py-2">{t('users.thCreated')}</th>
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
 {isSelf && <span className="ml-2 text-xs font-normal text-slate-400 dark:text-slate-500">{t('users.you')}</span>}
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
 <option value="user">{t('users.roleUser')}</option>
 <option value="admin">{t('users.roleAdmin')}</option>
 </select>
 </td>
 <td className="px-3 py-2 text-xs">
 {u.banned ? (
 <span className="badge bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-300">
 <Ban className="h-3 w-3" /> {t('users.statusBanned')}
 </span>
 ) : u.role !== 'admin' && !u.approved ? (
 <span className="badge bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300">
 ⏳ {t('users.statusPending')}
 </span>
 ) : (
 <span className="badge bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-300">
 <Check className="h-3 w-3" /> {t('users.statusActive')}
 </span>
 )}
 </td>
 <td className="px-3 py-2 text-xs">{formatBytes(u.quotaBytes)}</td>
 <td className="px-3 py-2 text-xs">{formatBytes(u.usedBytes)}</td>
 <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{formatDate(u.createdAt)}</td>
 <td className="px-3 py-2 text-right">
 <div className="flex justify-end">
 <ActionMenu
 label={t('users.actionsFor', { email: u.email })}
 items={[
 { label: t('users.browseFiles'), icon: FolderOpen, onClick: () => navigate(`/files?as=${u.id}`) },
 { label: t('users.setQuota'), icon: Gauge, onClick: () => updateQuota(u) },
 { label: t('users.resetPassword'), icon: KeyRound, onClick: () => resetPassword(u) },
 !isSelf && u.role !== 'admin' && {
 label: u.approved ? t('users.revokeApproval') : t('users.approve'),
 icon: u.approved ? UserX : UserCheck,
 onClick: () => toggleApprove(u),
 },
 !isSelf && {
 label: u.banned ? t('users.unban') : t('users.ban'),
 icon: u.banned ? Check : Ban,
 danger: !u.banned,
 onClick: () => toggleBan(u),
 },
 !isSelf && { label: t('users.deleteUser'), icon: Trash2, danger: true, onClick: () => remove(u) },
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
 {t('users.empty')}
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
 <ShieldCheck className="mr-1 inline h-3.5 w-3.5 align-text-bottom" />
 <Trans i18nKey="users.footer"><strong>pending</strong></Trans>
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
 const { t } = useTranslation();
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
 toast.success(t('groups.groupCreated'));
 } catch (err) {
 toast.error(err.response?.data?.error || t('groups.createFailed'));
 }
 };

 const rename = async (g) => {
 const name = await promptDialog({
 title: t('groups.renameTitle'),
 defaultValue: g.name,
 confirmText: t('files.rename'),
 });
 if (!name || name === g.name) return;
 try {
 await GroupApi.rename(g.id, name);
 refresh();
 } catch (err) {
 toast.error(err.response?.data?.error || t('groups.renameFailed'));
 }
 };

 const remove = async (g) => {
 const ok = await confirmDialog({
 title: t('groups.deleteTitle', { name: g.name }),
 message: t('groups.deleteMsg'),
 confirmText: t('groups.deleteGroup'),
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
 toast.success(t('groups.added', { id: identifier }));
 } catch (err) {
 toast.error(err.response?.data?.error || t('groups.addFailed'));
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
 <h2 className="text-base font-semibold">{t('groups.title')}</h2>
 </div>
 <div className="card p-4">
 <form onSubmit={create} className="mb-4 flex gap-2">
 <input
 className="input max-w-xs"
 placeholder={t('groups.newGroupName')}
 value={newName}
 maxLength={80}
 onChange={(e) => setNewName(e.target.value)}
 />
 <button type="submit" className="btn-primary shrink-0">
 <Plus className="h-4 w-4" /> {t('groups.createGroup')}
 </button>
 </form>
 {groups.length === 0 && (
 <div className="py-4 text-center text-sm text-slate-500 dark:text-slate-400">
 {t('groups.empty')}
 </div>
 )}
 <div className="space-y-4">
 {groups.map((g) => (
 <div key={g.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
 <div className="mb-2 flex items-center gap-2">
 <span className="font-medium text-slate-900 dark:text-slate-100">{g.name}</span>
 <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
 {t('groups.memberCount', { count: g.memberCount })}
 </span>
 <div className="ml-auto flex gap-1">
 <button
 className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
 onClick={() => rename(g)}
 title={t('groups.renameGroup')}
 >
 <Pencil className="h-3.5 w-3.5" />
 </button>
 <button
 className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800"
 onClick={() => remove(g)}
 title={t('groups.deleteGroup')}
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
 title={t('groups.removeFromGroup')}
 aria-label={t('groups.removeAria', { email: u.email, group: g.name })}
 >
 <UserMinus className="h-3 w-3" />
 </button>
 </span>
 ))}
 {(g.members || []).length === 0 && (
 <span className="text-xs text-slate-400 dark:text-slate-500">{t('groups.noMembers')}</span>
 )}
 </div>
 <form onSubmit={(e) => addMember(e, g)} className="flex gap-2">
 <input
 className="input max-w-xs"
 placeholder={t('groups.addMemberPlaceholder')}
 value={memberInput[g.id] || ''}
 onChange={(e) => setMemberInput((m) => ({ ...m, [g.id]: e.target.value }))}
 />
 <button type="submit" className="btn-secondary shrink-0">
 <UserPlus className="h-4 w-4" /> {t('groups.add')}
 </button>
 </form>
 </div>
 ))}
 </div>
 </div>
 </div>
 );
}
