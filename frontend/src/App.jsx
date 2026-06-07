import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './store/auth.js';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Files from './pages/Files.jsx';

// Non-critical routes are code-split so the initial bundle stays small.
const Register = lazy(() => import('./pages/Register.jsx'));
const VerifyEmail = lazy(() => import('./pages/VerifyEmail.jsx'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword.jsx'));
const ResetPassword = lazy(() => import('./pages/ResetPassword.jsx'));
const Audit = lazy(() => import('./pages/Audit.jsx'));
const Recent = lazy(() => import('./pages/Recent.jsx'));
const Starred = lazy(() => import('./pages/Starred.jsx'));
const SharedWithMe = lazy(() => import('./pages/SharedWithMe.jsx'));
const Trash = lazy(() => import('./pages/Trash.jsx'));
const Shares = lazy(() => import('./pages/Shares.jsx'));
const Shared = lazy(() => import('./pages/Shared.jsx'));
const Users = lazy(() => import('./pages/Users.jsx'));
const Profile = lazy(() => import('./pages/Profile.jsx'));
const Stats = lazy(() => import('./pages/Stats.jsx'));
const Duplicates = lazy(() => import('./pages/Duplicates.jsx'));
const Collections = lazy(() => import('./pages/Collections.jsx'));
const CollectionView = lazy(() => import('./pages/CollectionView.jsx'));

function Protected({ children, role }) {
  const { token, user } = useAuth();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (role && user.role !== role) return <Navigate to="/" replace />;
  return children;
}

const routeFallback = (
  <div className="flex h-[100dvh] items-center justify-center text-sm text-slate-400">Loading…</div>
);

export default function App() {
  return (
    <Suspense fallback={routeFallback}>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/s/:token" element={<Shared />} />

      <Route
        path="/"
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route index element={<Navigate to="/files" replace />} />
        <Route path="files" element={<Files />} />
        <Route path="files/:folderId" element={<Files />} />
        <Route path="recent" element={<Recent />} />
        <Route path="starred" element={<Starred />} />
        <Route path="stats" element={<Stats />} />
        <Route path="duplicates" element={<Duplicates />} />
        <Route path="collections" element={<Collections />} />
        <Route path="collections/:id" element={<CollectionView />} />
        <Route path="shared-with-me" element={<SharedWithMe />} />
        <Route path="trash" element={<Trash />} />
        <Route path="shares" element={<Shares />} />
        <Route path="profile" element={<Profile />} />
        <Route
          path="users"
          element={
            <Protected role="admin">
              <Users />
            </Protected>
          }
        />
        <Route
          path="audit"
          element={
            <Protected role="admin">
              <Audit />
            </Protected>
          }
        />
        <Route path="admin" element={<Navigate to="/users" replace />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}
