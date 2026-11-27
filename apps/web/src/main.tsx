import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createApi } from './api/client';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root introuvable');
createRoot(root).render(
  <StrictMode>
    <App makeApi={(onUnauthorized) => createApi({ baseUrl: '/api', onUnauthorized })} />
  </StrictMode>,
);
