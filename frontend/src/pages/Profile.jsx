import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Key, Plus, Trash2, Copy, Check, Monitor, LogOut, ShieldCheck, ShieldOff, Languages, Bell, BellOff } from 'lucide-react';
import { UserApi, KeyApi, AuthApi } from '../api/endpoints.js';
import { useAuth } from '../store/auth.js';
import { useLocale } from '../store/locale.js';
import { formatBytes, formatDate } from '../lib/format.js';
import { copyText } from '../lib/uid.js';
import { getPushState, serverPushEnabled, enablePush, disablePush } from '../lib/push.js';

// Task5 #7 — Web Push opt-in. Subscribes this browser's PushManager so the user
// is reached even with no tab open. Needs a registered SW (PROD/localhost) + a
// secure context; the card explains why it's unavailable otherwise.
function PushCard() {
  const { t } = useTranslation();
  const [state, setState] = useState(null); // { supported, subscribed, permission }
  const [serverOn, setServerOn] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setState(await getPushState());
    setServerOn(await serverPushEnabled());
  };
  useEffect(() => {
    refresh();
  }, []);

  const toggle = async () => {
    setBusy(true);
    try {
      if (state?.subscribed) {
        await disablePush();
        toast.success(t('profile.pushDisabledToast'));
      } else {
        await enablePush();
        toast.success(t('profile.pushEnabledToast'));
      }
      await refresh();
    } catch (e) {
      const map = {
        unsupported: t('profile.pushUnsupported'),
        'not-configured': t('profile.pushNotConfigured'),
        denied: t('profile.pushDenied'),
        'no-sw': t('profile.pushNoSw'),
      };
      toast.error(map[e?.message] || t('profile.pushFailed'));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const enabled = !!state?.subscribed;
  const unavailable = state && (!state.supported || !serverOn);
  const note =
    state && !state.supported
      ? t('profile.pushUnsupported')
      : !serverOn
      ? t('profile.pushNotConfigured')
      : state?.permission === 'denied'
      ? t('profile.pushDenied')
      : null;

  return (
    <div className="card p-5 text-sm lg:col-span-2">
      <div className="mb-2 flex items-center gap-2 font-medium">
        {enabled ? (
          <Bell className="h-4 w-4 text-brand-600 dark:text-brand-400" />
        ) : (
          <BellOff className="h-4 w-4 text-slate-400" />
        )}
        {t('profile.push')}
        {enabled && (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
            {t('profile.pushEnabled')}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{t('profile.pushHint')}</p>
      {note && <p className="mb-3 text-xs text-amber-600 dark:text-amber-400">{note}</p>}
      <button
        onClick={toggle}
        disabled={busy || unavailable || state?.permission === 'denied'}
        className={enabled ? 'btn-secondary' : 'btn-primary'}
      >
        {enabled ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
        {enabled ? t('profile.pushDisable') : t('profile.pushEnable')}
      </button>
    </div>
  );
}

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'vi', label: 'Tiếng Việt' },
];

// Task5 #22 — interface language picker (persisted on this device).
function LanguageCard() {
  const { t } = useTranslation();
  const { language, setLanguage } = useLocale();
  return (
    <div className="card p-5 text-sm">
      <div className="mb-2 flex items-center gap-2 font-medium">
        <Languages className="h-4 w-4 text-brand-600 dark:text-brand-400" /> {t('profile.language')}
      </div>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{t('profile.languageHint')}</p>
      <div className="flex gap-2">
        {LANGUAGES.map((l) => (
          <button
            key={l.code}
            onClick={() => setLanguage(l.code)}
            className={
              'rounded-md border px-3 py-1.5 text-sm transition ' +
              (language === l.code
                ? 'border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300'
                : 'border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800')
            }
          >
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Best-effort friendly label from a User-Agent string.
function deviceLabel(ua) {
  if (!ua) return 'Unknown device';
  const os = /Windows/i.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/i.test(ua)
    ? 'macOS'
    : /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iOS/i.test(ua)
    ? 'iOS'
    : /Linux/i.test(ua)
    ? 'Linux'
    : 'Unknown OS';
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /Chrome\//i.test(ua)
    ? 'Chrome'
    : /Firefox\//i.test(ua)
    ? 'Firefox'
    : /Safari\//i.test(ua)
    ? 'Safari'
    : 'Browser';
  return `${browser} · ${os}`;
}

function SessionsCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['sessions'], queryFn: () => AuthApi.sessions() });
  const [busy, setBusy] = useState(false);
  const sessions = data?.sessions || [];
  const others = sessions.filter((s) => !s.current).length;

  const revoke = async (s) => {
    await AuthApi.revokeSession(s.id);
    qc.invalidateQueries({ queryKey: ['sessions'] });
  };
  const revokeOthers = async () => {
    setBusy(true);
    try {
      const r = await AuthApi.revokeOtherSessions();
      toast.success(t('profile.signedOutOthers', { count: r.count }));
      qc.invalidateQueries({ queryKey: ['sessions'] });
    } catch (e) {
      toast.error(e.response?.data?.error || t('common.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-5 text-sm lg:col-span-2">
      <div className="mb-2 flex items-center gap-2 font-medium">
        <Monitor className="h-4 w-4 text-brand-600 dark:text-brand-400" /> {t('profile.activeSessions')}
      </div>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        {t('profile.sessionsHint')}
      </p>

      <div className="space-y-1">
        {sessions.length === 0 && (
          <div className="py-2 text-center text-xs text-slate-400">{t('profile.noSessions')}</div>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/40"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-slate-800 dark:text-slate-200">
                {deviceLabel(s.userAgent)}{' '}
                {s.current && (
                  <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                    {t('profile.thisDevice')}
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-400">
                {s.ip || t('profile.unknownIp')} · {t('profile.lastActive', { date: formatDate(s.lastSeenAt) })}
              </div>
            </div>
            {!s.current && (
              <button
                onClick={() => revoke(s)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-700"
                title={t('profile.signOutDevice')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      {others > 0 && (
        <button
          onClick={revokeOthers}
          disabled={busy}
          className="mt-3 inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <LogOut className="h-3.5 w-3.5" /> {t('profile.signOutOthers')}
        </button>
      )}
    </div>
  );
}

// Task5 #1 — enable/disable TOTP two-factor auth.
function TwoFactorCard() {
  const { t } = useTranslation();
  const { user, setUser } = useAuth();
  const enabled = !!user?.totpEnabled;
  const [setup, setSetup] = useState(null); // { qr, secret } during enrollment
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(null); // codes shown once after enable
  const [showDisable, setShowDisable] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const begin = async () => {
    setBusy(true);
    try {
      const r = await AuthApi.totpSetup();
      setSetup(r);
      setCode('');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to start setup');
    } finally {
      setBusy(false);
    }
  };

  const enable = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await AuthApi.totpEnable(code.trim());
      setUser(r.user);
      setSetup(null);
      setRecovery(r.recoveryCodes);
      toast.success(t('profile.twoFaEnabled'));
    } catch (e) {
      toast.error(e.response?.data?.error || t('profile.invalidCode'));
    } finally {
      setBusy(false);
    }
  };

  const disable = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await AuthApi.totpDisable(password, code.trim());
      setUser(r.user);
      setShowDisable(false);
      setPassword('');
      setCode('');
      toast.success(t('profile.twoFaDisabled'));
    } catch (e) {
      toast.error(e.response?.data?.error || t('common.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-5 text-sm lg:col-span-2">
      <div className="mb-2 flex items-center gap-2 font-medium">
        {enabled ? (
          <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <ShieldOff className="h-4 w-4 text-slate-400" />
        )}
        {t('profile.twoFactor')}
        {enabled && (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
            {t('profile.twoFactorEnabled')}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        {t('profile.twoFactorHint')}
      </p>

      {recovery && (
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
          <div className="mb-1 text-xs font-medium text-amber-800 dark:text-amber-300">
            {t('profile.saveRecoveryCodes')}
          </div>
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
            {recovery.map((c) => (
              <code key={c} className="rounded bg-white px-2 py-1 text-center text-xs dark:bg-slate-900">{c}</code>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={async () => {
                await copyText(recovery.join('\n'));
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-amber-300 px-2 py-1 text-xs text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/20"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {t('profile.copyAll')}
            </button>
            <button onClick={() => setRecovery(null)} className="text-xs text-slate-500 hover:underline dark:text-slate-400">
              {t('profile.savedThem')}
            </button>
          </div>
        </div>
      )}

      {!enabled && !setup && (
        <button onClick={begin} disabled={busy} className="btn-primary">
          <ShieldCheck className="h-4 w-4" /> {t('profile.enable2fa')}
        </button>
      )}

      {!enabled && setup && (
        <form onSubmit={enable} className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <img src={setup.qr} alt="TOTP QR code" className="h-40 w-40 rounded-md bg-white p-1" />
          <div className="flex-1 space-y-2">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {t('profile.scanQr')}
            </div>
            <code className="block truncate rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-950">{setup.secret}</code>
            <div className="text-xs text-slate-500 dark:text-slate-400">{t('profile.enterCode')}</div>
            <div className="flex gap-2">
              <input
                className="input max-w-[10rem] text-center tracking-widest"
                inputMode="numeric"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                required
              />
              <button type="submit" className="btn-primary shrink-0" disabled={busy || !code.trim()}>
                {t('profile.verifyEnable')}
              </button>
              <button type="button" onClick={() => setSetup(null)} className="btn-secondary shrink-0">
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </form>
      )}

      {enabled && !showDisable && (
        <button
          onClick={() => {
            setShowDisable(true);
            setCode('');
            setPassword('');
          }}
          className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <ShieldOff className="h-3.5 w-3.5" /> {t('profile.disable2fa')}
        </button>
      )}

      {enabled && showDisable && (
        <form onSubmit={disable} className="flex flex-col gap-2 sm:flex-row">
          <input
            type="password"
            className="input sm:max-w-[14rem]"
            placeholder={t('profile.accountPassword')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <input
            className="input sm:max-w-[12rem]"
            placeholder={t('profile.codeOrRecovery')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          <button type="submit" className="btn-primary shrink-0" disabled={busy}>
            {t('profile.disable')}
          </button>
          <button type="button" onClick={() => setShowDisable(false)} className="btn-secondary shrink-0">
            {t('common.cancel')}
          </button>
        </form>
      )}
    </div>
  );
}

function ApiKeysCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['apikeys'], queryFn: () => KeyApi.list() });
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null); // { key } shown once
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const keys = data?.keys || [];

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await KeyApi.create(name.trim());
      setCreated(r);
      setName('');
      qc.invalidateQueries({ queryKey: ['apikeys'] });
    } catch (e) {
      toast.error(e.response?.data?.error || t('common.failed'));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (k) => {
    await KeyApi.remove(k.id);
    qc.invalidateQueries({ queryKey: ['apikeys'] });
  };

  return (
    <div className="card p-5 text-sm lg:col-span-2">
      <div className="mb-2 flex items-center gap-2 font-medium">
        <Key className="h-4 w-4 text-brand-600 dark:text-brand-400" /> {t('profile.apiKeys')}
      </div>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        {t('profile.apiKeysHint')} <code>Authorization: Bearer &lt;key&gt;</code> /{' '}
        <code>X-API-Key</code>.
      </p>

      {created && (
        <div className="mb-3 rounded-md border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-500/40 dark:bg-emerald-500/10">
          <div className="mb-1 text-xs font-medium text-emerald-800 dark:text-emerald-300">
            {t('profile.copyKeyNow')}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-white px-2 py-1 text-xs dark:bg-slate-900">{created.key}</code>
            <button
              onClick={async () => {
                await copyText(created.key);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="rounded p-1 hover:bg-emerald-100 dark:hover:bg-emerald-500/20"
            >
              {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
        </div>
      )}

      <div className="mb-3 flex gap-2">
        <input
          className="input"
          placeholder={t('profile.keyNamePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
        <button className="btn-primary shrink-0" onClick={create} disabled={busy || !name.trim()}>
          <Plus className="h-4 w-4" /> {t('common.create')}
        </button>
      </div>

      <div className="space-y-1">
        {keys.length === 0 && <div className="py-2 text-center text-xs text-slate-400">{t('profile.noKeys')}</div>}
        {keys.map((k) => (
          <div key={k.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/40">
            <div className="min-w-0 flex-1">
              <div className="truncate text-slate-800 dark:text-slate-200">
                {k.name} {k.revokedAt && <span className="text-xs text-red-500">{t('profile.revoked')}</span>}
              </div>
              <div className="text-xs text-slate-400">
                <code>{k.prefix}…</code> · {t('profile.createdOn', { date: formatDate(k.createdAt) })}
                {k.lastUsedAt ? ` · ${t('profile.lastUsed', { date: formatDate(k.lastUsedAt) })}` : ` · ${t('profile.neverUsed')}`}
              </div>
            </div>
            {!k.revokedAt && (
              <button onClick={() => revoke(k)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-700" title={t('profile.revoke')}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Profile() {
 const { t } = useTranslation();
 const { user, setUser } = useAuth();
 const [name, setName] = useState(user?.name || '');
 const [password, setPassword] = useState('');
 const [confirm, setConfirm] = useState('');
 const [loading, setLoading] = useState(false);

 const submit = async (e) => {
 e.preventDefault();
 if (password) {
 if (password.length < 6) return toast.error(t('profile.passwordTooShort'));
 if (password !== confirm) return toast.error(t('profile.passwordsNoMatch'));
 }
 setLoading(true);
 try {
 const data = {};
 if (name && name !== user?.name) data.name = name;
 if (password) data.password = password;
 if (Object.keys(data).length === 0) {
 toast(t('profile.nothingToUpdate'));
 } else {
 const r = await UserApi.updateMe(data);
 setUser(r.user);
 setPassword('');
 setConfirm('');
 toast.success(t('common.saved'));
 }
 } catch (e) {
 toast.error(e.response?.data?.error || t('common.failed'));
 } finally {
 setLoading(false);
 }
 };

 return (
 <div className="p-6">
 <h1 className="mb-4 text-lg font-semibold">{t('profile.title')}</h1>
 <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
 <form onSubmit={submit} className="card space-y-3 p-5">
 <div>
 <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">{t('profile.username')}</label>
 <input className="input" value={user?.email || ''} disabled />
 </div>
 <div>
 <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">{t('profile.name')}</label>
 <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
 </div>
 <div>
 <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">{t('profile.newPassword')}</label>
 <input
 type="password"
 className="input"
 value={password}
 onChange={(e) => setPassword(e.target.value)}
 placeholder={t('profile.leaveEmpty')}
 autoComplete="new-password"
 minLength={6}
 />
 </div>
 {password && (
 <div>
 <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">
 {t('profile.confirmNewPassword')}
 </label>
 <input
 type="password"
 className="input"
 value={confirm}
 onChange={(e) => setConfirm(e.target.value)}
 placeholder={t('profile.reenterPassword')}
 autoComplete="new-password"
 required
 minLength={6}
 />
 </div>
 )}
 <button disabled={loading} className="btn-primary w-full justify-center">
 {loading ? t('profile.saving') : t('common.save')}
 </button>
 </form>

 <div className="card p-5 text-sm">
 <div className="mb-3 font-medium">{t('profile.storage')}</div>
 <div className="mb-1 text-slate-500 dark:text-slate-400">
 {t('profile.usedOf', { used: formatBytes(user?.usedBytes || 0), total: formatBytes(user?.quotaBytes || 0) })}
 </div>
 <div className="h-2 w-full overflow-hidden rounded bg-slate-200 dark:bg-slate-800">
 <div
 className="h-full bg-brand-500"
 style={{
 width:
 user && user.quotaBytes
 ? Math.min(
 100,
 Math.round((Number(user.usedBytes) / Number(user.quotaBytes)) * 100),
 ) + '%'
 : '0%',
 }}
 />
 </div>
 <div className="mt-4 text-xs text-slate-500 dark:text-slate-400">{t('profile.role', { role: user?.role })}</div>
 </div>

 <LanguageCard />

 <div className="card p-5 text-sm lg:col-span-2">
 <div className="mb-2 font-medium">{t('profile.webdav')}</div>
 <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
 {t('profile.webdavHint')}
 </p>
 <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-950">
 <code className="flex-1 truncate text-xs text-slate-700 dark:text-slate-200">{window.location.origin}/webdav</code>
 </div>
 <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
 {t('profile.username')}: <span className="font-medium text-slate-700 dark:text-slate-300">{user?.email}</span>
 {' · '}macOS Finder: <em>Go → Connect to Server</em>; Windows: <em>Map network drive</em>.
 </div>
 </div>

 <TwoFactorCard />

 <PushCard />

 <SessionsCard />

 <ApiKeysCard />
 </div>
 </div>
 );
}
