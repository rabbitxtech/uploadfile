import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';
import { AuditApi } from '../api/endpoints.js';
import { formatDate } from '../lib/format.js';

const ACTION_STYLE = {
  login: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
  login_failed: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300',
  user_ban: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300',
  user_unban: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
  user_delete: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300',
};
const styleFor = (a) => ACTION_STYLE[a] || 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300';

const FILTERS = ['', 'login', 'login_failed', 'user_ban', 'user_role_change', 'user_quota_change', 'share_create', 'password_reset', 'apikey_create'];

export default function Audit() {
  const { t } = useTranslation();
  const [action, setAction] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['audit', action],
    queryFn: () => AuditApi.list({ action: action || undefined, limit: 200 }),
  });
  const logs = data?.logs || [];

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ShieldAlert className="h-5 w-5 text-brand-600 dark:text-brand-400" />
        <h1 className="text-lg font-semibold">{t('nav.auditLog')}</h1>
        <select className="select-sm ml-auto" value={action} onChange={(e) => setAction(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f} value={f}>
              {f || t('audit.allActions')}
            </option>
          ))}
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
            <tr>
              <th className="px-3 py-2">{t('audit.thTime')}</th>
              <th className="px-3 py-2">{t('audit.thAction')}</th>
              <th className="px-3 py-2">{t('audit.thBy')}</th>
              <th className="px-3 py-2">{t('audit.thTarget')}</th>
              <th className="px-3 py-2">{t('audit.thIp')}</th>
              <th className="px-3 py-2">{t('audit.thDetails')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {isLoading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-slate-400">{t('common.loading')}</td>
              </tr>
            )}
            {logs.map((l) => (
              <tr key={l.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{formatDate(l.createdAt)}</td>
                <td className="px-3 py-2">
                  <span className={`badge ${styleFor(l.action)}`}>{l.action}</span>
                </td>
                <td className="px-3 py-2 text-xs text-slate-700 dark:text-slate-200">{l.user ? l.user.name || l.user.email : '—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
                  {l.targetType ? `${l.targetType}:${(l.targetId || '').slice(0, 8)}` : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-slate-400">{l.ip || '—'}</td>
                <td className="max-w-xs truncate px-3 py-2 text-xs text-slate-400" title={l.meta ? JSON.stringify(l.meta) : ''}>
                  {l.meta ? JSON.stringify(l.meta) : ''}
                </td>
              </tr>
            ))}
            {!isLoading && logs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-slate-400">{t('audit.empty')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
