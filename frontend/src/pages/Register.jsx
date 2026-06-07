import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Cloud, MailCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { AuthApi } from '../api/endpoints.js';
import { useAuth } from '../store/auth.js';

export default function Register() {
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
 if (password.length < 6) return toast.error('Password must be at least 6 characters');
 if (password !== confirm) return toast.error('Passwords do not match');
 setLoading(true);
 try {
 const data = await AuthApi.register({ email, password, name });
 if (data.token) {
 // First user (admin) is auto-verified and signed in immediately.
 setSession(data);
 toast.success('Account created');
 navigate('/files');
 } else {
 // Everyone else must confirm their email first.
 setSentTo(data.email || email);
 }
 } catch (e) {
 toast.error(e.response?.data?.error || 'Registration failed');
 } finally {
 setLoading(false);
 }
 };

 const resend = async () => {
 setResending(true);
 try {
 await AuthApi.resendVerification(sentTo);
 toast.success('Verification email re-sent');
 } catch {
 toast.error('Could not resend — try again later');
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
 <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">Check your email</h1>
 <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
 We sent a verification link to <span className="font-medium text-slate-700 dark:text-slate-200">{sentTo}</span>.
 Click it to activate your account, then sign in.
 </p>
 <button
 onClick={resend}
 disabled={resending}
 className="btn-secondary mt-5 w-full justify-center"
 >
 {resending ? 'Resending…' : 'Resend verification email'}
 </button>
 <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
 <Link to="/login" className="text-brand-600 dark:text-brand-400 hover:underline">
 Back to sign in
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
 <span className="text-xl font-semibold">Create account</span>
 </div>
 <div className="space-y-3">
 <input
 placeholder="Display name (optional)"
 className="input"
 value={name}
 onChange={(e) => setName(e.target.value)}
 />
 <input
 type="email"
 placeholder="Email address"
 required
 autoComplete="email"
 className="input"
 value={email}
 onChange={(e) => setEmail(e.target.value)}
 />
 <input
 type="password"
 placeholder="Password (min 6 chars)"
 required
 minLength={6}
 autoComplete="new-password"
 className="input"
 value={password}
 onChange={(e) => setPassword(e.target.value)}
 />
 <input
 type="password"
 placeholder="Confirm password"
 required
 minLength={6}
 autoComplete="new-password"
 className="input"
 value={confirm}
 onChange={(e) => setConfirm(e.target.value)}
 />
 </div>
 <button type="submit" disabled={loading} className="btn-primary mt-4 w-full justify-center">
 {loading ? 'Creating...' : 'Create account'}
 </button>
 <p className="mt-3 text-center text-xs text-slate-400 dark:text-slate-500">
 We'll email you a link to verify your address.
 </p>
 <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
 Have an account?{' '}
 <Link to="/login" className="text-brand-600 dark:text-brand-400 hover:underline">
 Sign in
 </Link>
 </p>
 </form>
 </div>
 );
}
