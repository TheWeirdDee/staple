import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Link, Route, Routes } from 'react-router-dom';
import { MotionConfig } from 'framer-motion';
import './styles.css';
import { Layout } from './components/Layout';
import { Landing } from './pages/Landing';
import { MandateRoute } from './pages/Mandate';
import { Console } from './pages/Console';
import { Manage } from './pages/Manage';
import { Proof } from './pages/Proof';
import { Docs } from './pages/Docs';
import { WalletProvider } from './lib/wallet';

function NotFound() {
  return (
    <div className="wrap stack-lg" style={{ padding: '96px var(--gutter)' }}>
      <h1 className="h1">Page not found.</h1>
      <p className="body">The address doesn’t match any page.</p>
      <Link to="/" className="btn ghost">
        Back to start
      </Link>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <WalletProvider>
        {/* Hash routing keeps deep links working on static hosting without server rewrites. */}
        <HashRouter>
          <Layout>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/mandate" element={<MandateRoute />} />
              <Route path="/mandate/:id" element={<MandateRoute />} />
              <Route path="/console" element={<Console />} />
              <Route path="/console/:id" element={<Manage />} />
              <Route path="/proof" element={<Proof />} />
              <Route path="/docs" element={<Docs />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Layout>
        </HashRouter>
      </WalletProvider>
    </MotionConfig>
  </StrictMode>,
);
