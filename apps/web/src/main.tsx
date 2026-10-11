import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { DemoBanner } from './demo/DemoBanner';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      {import.meta.env.VITE_DEMO && <DemoBanner />}
      <App />
    </BrowserRouter>
  </StrictMode>,
);

// The online demo skips the service worker: it would cache one visitor's demo data as app shell.
if ('serviceWorker' in navigator && import.meta.env.PROD && !import.meta.env.VITE_DEMO) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
