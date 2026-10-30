import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './styles.css';
import { AuthProvider, useAuth } from './auth';
import { ToastProvider } from './toast';
import { LoginPage, VerifyPage } from './pages/Login';
import { ProjectsPage } from './pages/Projects';
import { WorkspacePage } from './pages/Workspace';
import { OverviewPage } from './pages/Overview';

function Home() {
  const { user, loading } = useAuth();
  if (loading) return null;
  return <Navigate to={user ? '/projects' : '/login'} replace />;
}

function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth/verify" element={<VerifyPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:projectId" element={<WorkspacePage />} />
            <Route path="/projects/:projectId/comments" element={<OverviewPage />} />
            <Route path="/s/:shareToken" element={<WorkspacePage />} />
            <Route path="/s/:shareToken/comments" element={<OverviewPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
