import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { AuthApi } from '../api/endpoints.js';
import { useAuth } from '../store/auth.js';

export default function VerifyEmail() {
 const [params] = useSearchParams();
 const token = params.get('token');
 const [status, setStatus] = useState('verifying'); // verifying | ok | error
 const setSession = useAuth((s) => s.setSession);
 const navigate = useNavigate();
 const ran = useRef(false);

 useEffect(() => {
 if (ran.current) return; // guard StrictMode double-invoke (token is single-use)
 ran.current = true;
 if (!token) {
 setStatus('error');
 return;
 }
 AuthApi.verifyEmail(token)
 .then((data) => {
 setStatus('ok');
 if (data.token) {
 setSession(data);
 toast.success('Email verified — welcome!');
 setTimeout(() => navigate('/files'), 800);
 }
 })
 .catch(() => setStatus('error'));
 }, [token, setSession, navigate]);

 return (
 <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
 <div className="card w-full max-w-sm p-6 text-center">
 {status === 'verifying' && (
 <>
 <Loader2 className="mx-auto h-12 w-12 animate-spin text-brand-600 dark:text-brand-400" />
 <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">Verifying your email…</p>
 </>
 )}
 {status === 'ok' && (
 <>
 <CheckCircle2 className="mx-auto h-12 w-12 text-green-600 dark:text-green-400" />
 <h1 className="mt-4 text-lg font-semibold text-slate-800 dark:text-slate-100">Email verified</h1>
 <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
 Your account is active. Taking you to your files…
 </p>
 <Link to="/files" className="btn-primary mt-5 w-full justify-center">
 Go to my files
 </Link>
 </>
 )}
 {status === 'error' && (
 <>
 <XCircle className="mx-auto h-12 w-12 text-red-500 dark:text-red-400" />
 <h1 className="mt-4 text-lg font-semibold text-slate-800 dark:text-slate-100">Verification failed</h1>
 <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
 This link is invalid or has expired. You can request a new one from the sign-in page.
 </p>
 <Link to="/login" className="btn-primary mt-5 w-full justify-center">
 Back to sign in
 </Link>
 </>
 )}
 </div>
 </div>
 );
}
