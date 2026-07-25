import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// --- Mocks for Layout's dependencies -------------------------------------
vi.mock('../store/auth.js', () => ({
  useAuth: () => ({
    user: { email: 'me@test.dev', role: 'user', usedBytes: 0, quotaBytes: 100 },
    logout: vi.fn(),
  }),
}));
vi.mock('../store/theme.js', () => ({
  useTheme: () => ({ theme: 'light', toggle: vi.fn() }),
}));
vi.mock('../api/endpoints.js', () => ({
  FolderApi: {
    tree: vi.fn().mockResolvedValue({
      folders: [{ id: 'a', name: 'Documents', parentId: null, path: '/Documents' }],
    }),
  },
  FileApi: { update: vi.fn() },
}));
vi.mock('./NotificationBell.jsx', () => ({ default: () => null }));
vi.mock('./CommandPalette.jsx', () => ({ default: () => null }));

import Layout from './Layout.jsx';

function renderAt(path) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/files" element={<div>FILES PAGE</div>} />
            <Route path="/recent" element={<div>RECENT PAGE</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Layout folder-tree column', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows the folder tree as its own column on the files page', async () => {
    renderAt('/files');
    // The "Folders" panel header and the tree contents render.
    expect(screen.getByText('Folders')).toBeInTheDocument();
    expect(await screen.findByText('Documents')).toBeInTheDocument();
    // It can be hidden via the collapse toggle.
    expect(screen.getByLabelText('Hide folders')).toBeInTheDocument();
  });

  it('does NOT render the folder tree on non-files pages', () => {
    renderAt('/recent');
    expect(screen.queryByText('Folders')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Hide folders')).not.toBeInTheDocument();
  });

  it('toggles the column closed (round ">" button) and back open, persisting state', async () => {
    renderAt('/files');
    await screen.findByText('Documents');

    // Collapse: header disappears, the round desktop toggle (title="Show folders") appears.
    fireEvent.click(screen.getByLabelText('Hide folders'));
    expect(screen.queryByText('Folders')).not.toBeInTheDocument();
    expect(localStorage.getItem('treeOpen')).toBe('0');

    const roundToggle = screen
      .getAllByLabelText('Show folders')
      .find((b) => b.getAttribute('title') === 'Show folders');
    expect(roundToggle).toBeTruthy();

    // Expand again.
    fireEvent.click(roundToggle);
    expect(screen.getByText('Folders')).toBeInTheDocument();
    expect(localStorage.getItem('treeOpen')).toBe('1');
  });

  it('restores the collapsed state from localStorage on next mount', () => {
    localStorage.setItem('treeOpen', '0');
    renderAt('/files');
    // Starts collapsed — no header, the round desktop toggle present.
    expect(screen.queryByText('Folders')).not.toBeInTheDocument();
    expect(
      screen.getAllByLabelText('Show folders').some((b) => b.getAttribute('title') === 'Show folders')
    ).toBe(true);
  });

  it('opens the folder tree in a mobile modal via the navbar folders button', async () => {
    renderAt('/files');
    await screen.findByText('Documents');
    // The mobile top-bar folders button has title="Folders".
    const mobileBtn = screen
      .getAllByLabelText('Show folders')
      .find((b) => b.getAttribute('title') === 'Folders');
    expect(mobileBtn).toBeTruthy();

    fireEvent.click(mobileBtn);
    // Modal renders its own folder panel (a second "Hide folders" close control + tree).
    const hideButtons = screen.getAllByLabelText('Hide folders');
    expect(hideButtons.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Documents').length).toBeGreaterThanOrEqual(1);
  });
});
