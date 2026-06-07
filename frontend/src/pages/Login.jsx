import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Cloud } from 'lucide-react';
import toast from 'react-hot-toast';
import { AuthApi } from '../api/endpoints.js';
import { useAuth } from '../store/auth.js';

export default function Login() {
 const [email, setEmail] = useState('');
 const [password, setPassword] = useState('');
 const [loading, setLoading] = useState(false);
 const [unverified, setUnverified] = useState(false); // login blocked: email not verified
 const [resending, setResending] = useState(false);
 const setSession = useAuth((s) => s.setSession);
 const navigate = useNavigate();

 const submit = async (e) => {
 e.preventDefault();
 setLoading(true);
 setUnverified(false);
 try {
 const data = await AuthApi.login({ email, password });
 setSession(data);
 toast.success('Welcome back');
 navigate('/files');
 } catch (e) {
 const msg = e.response?.data?.error || 'Login failed';
 if (e.response?.status === 403 && /verify your email/i.test(msg)) {
 setUnverified(true);
 }
 toast.error(msg);
 } finally {
 setLoading(false);
 }
 };

 const resend = async () => {
 setResending(true);
 try {
 await AuthApi.resendVerification(email);
 toast.success('Verification email re-sent — check your inbox');
 } catch {
 toast.error('Could not resend — try again later');
 } finally {
 setResending(false);
 }
 };

 return (
 <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
 <form onSubmit={submit} className="card w-full max-w-sm p-6">
 <div className="mb-6 flex items-center gap-2 text-brand-700 dark:text-brand-400">
 <Cloud className="h-7 w-7" />
 <span className="text-xl font-semibold">Sign in</span>
 </div>
 <div className="space-y-3">
 <input
 type="text"
 placeholder="Username or email"
 required
 autoComplete="username"
 className="input"
 value={email}
 onChange={(e) => setEmail(e.target.value)}
 />
 <input
 type="password"
 placeholder="Password"
 required
 autoComplete="current-password"
 className="input"
 value={password}
 onChange={(e) => setPassword(e.target.value)}
 />
 </div>
 <button type="submit" disabled={loading} className="btn-primary mt-4 w-full justify-center">
 {loading ? 'Signing in...' : 'Sign in'}
 </button>

 {unverified && (
 <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
 Your email isn't verified yet.{' '}
 <button
 type="button"
 onClick={resend}
 disabled={resending}
 className="font-medium underline hover:no-underline disabled:opacity-60"
 >
 {resending ? 'Resending…' : 'Resend verification email'}
 </button>
 </div>
 )}

 <p className="mt-3 text-center text-sm">
 <Link to="/forgot-password" className="text-brand-600 hover:underline dark:text-brand-400">
 Forgot password?
 </Link>
 </p>
 <p className="mt-2 text-center text-sm text-slate-500 dark:text-slate-400">
 New here?{' '}
 <Link to="/register" className="text-brand-600 dark:text-brand-400 hover:underline">
 Create an account
 </Link>
 </p>
 </form>
 </div>
 );
}
