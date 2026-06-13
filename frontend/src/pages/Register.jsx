import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import { Cloud, MailCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { AuthApi } from '../api/endpoints.js';
import { useAuth } from '../store/auth.js';

export default function Register() {
 const { t } = useTranslation();
 const [email, setEmail] = useState('');
 const [password, setPassword] = useState('');
 const [confirm, setConfirm] = useState('');
 const [name, setName] = useState('');
 const [loading, setLoading] = useState(false);
 const [sentTo, setSentTo] = useState(null); // set once a verification email is sent
 const [resending, setResending] = useState(false);
 const setSession = useAuth((s) => s.setSession);
 const navigate = useNavigate();

 const submit = async (e) => {
 e.preventDefault();
 if (password.length < 6) return toast.error(t('profile.passwordTooShort'));
 if (password !== confirm) return toast.error(t('profile.passwordsNoMatch'));
 setLoading(true);
 try {
 const data = await AuthApi.register({ email, password, name });
 if (data.token) {
 // First user (admin) is auto-verified and signed in immediately.
 setSession(data);
 toast.success(t('register.accountCreated'));
 navigate('/files');
 } else {
 // Everyone else must confirm their email first.
 setSentTo(data.email || email);
 }
 } catch (e) {
 toast.error(e.response?.data?.error || t('register.registrationFailed'));
 } finally {
 setLoading(false);
 }
 };

 const resend = async () => {
 setResending(true);
 try {
 await AuthApi.resendVerification(sentTo);
 toast.success(t('register.verificationResent'));
 } catch {
 toast.error(t('auth.resendFailed'));
 } finally {
 setResending(false);
 }
 };

 if (sentTo) {
 return (
 <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
 <div className="card w-full max-w-sm p-6 text-center">
 <div className="mb-4 flex justify-center text-brand-600 dark:text-brand-400">
 <MailCheck className="h-12 w-12" />
 </div>
 <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{t('register.checkEmail')}</h1>
 <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
 <Trans i18nKey="register.sentLinkTo" values={{ email: sentTo }}>
 <span className="font-medium text-slate-700 dark:text-slate-200">email</span>
 </Trans>
 </p>
 <button
 onClick={resend}
 disabled={resending}
 className="btn-secondary mt-5 w-full justify-center"
 >
 {resending ? t('auth.resending') : t('auth.resendVerification')}
 </button>
 <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
 <Link to="/login" className="text-brand-600 dark:text-brand-400 hover:underline">
 {t('auth.backToSignIn')}
 </Link>
 </p>
 </div>
 </div>
 );
 }

 return (
 <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
 <form onSubmit={submit} className="card w-full max-w-sm p-6">
 <div className="mb-6 flex items-center gap-2 text-brand-700 dark:text-brand-400">
 <Cloud className="h-7 w-7" />
 <span className="text-xl font-semibold">{t('register.title')}</span>
 </div>
 <div className="space-y-3">
 <input
 placeholder={t('register.displayName')}
 className="input"
 value={name}
 onChange={(e) => setName(e.target.value)}
 />
 <input
 type="email"
 placeholder={t('register.email')}
 required
 autoComplete="email"
 className="input"
 value={email}
 onChange={(e) => setEmail(e.target.value)}
 />
 <input
 type="password"
 placeholder={t('register.passwordMin')}
 required
 minLength={6}
 autoComplete="new-password"
 className="input"
 value={password}
 onChange={(e) => setPassword(e.target.value)}
 />
 <input
 type="password"
 placeholder={t('register.confirmPassword')}
 required
 minLength={6}
 autoComplete="new-password"
 className="input"
 value={confirm}
 onChange={(e) => setConfirm(e.target.value)}
 />
 </div>
 <button type="submit" disabled={loading} className="btn-primary mt-4 w-full justify-center">
 {loading ? t('register.creating') : t('register.title')}
 </button>
 <p className="mt-3 text-center text-xs text-slate-400 dark:text-slate-500">
 {t('register.verifyNote')}
 </p>
 <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
 {t('register.haveAccount')}{' '}
 <Link to="/login" className="text-brand-600 dark:text-brand-400 hover:underline">
 {t('auth.signIn')}
 </Link>
 </p>
 </form>
 </div>
 );
}
