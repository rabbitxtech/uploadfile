import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FolderTree from './FolderTree.jsx';

const folders = [
  { id: 'a', name: 'Documents', parentId: null, path: '/Documents' },
  { id: 'b', name: 'Photos', parentId: null, path: '/Photos' },
];

describe('FolderTree', () => {
  it('renders Root plus top-level folders', () => {
    render(<FolderTree folders={folders} currentId={null} onPick={() => {}} />);
    expect(screen.getByText('Root')).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
    expect(screen.getByText('Photos')).toBeInTheDocument();
  });

  it('calls onPick with the folder id when clicked', () => {
    const onPick = vi.fn();
    render(<FolderTree folders={folders} currentId={null} onPick={onPick} />);
    fireEvent.click(screen.getByText('Photos'));
    expect(onPick).toHaveBeenCalledWith('b');
  });

  it('shows an empty hint with no folders', () => {
    render(<FolderTree folders={[]} currentId={null} onPick={() => {}} />);
    expect(screen.getByText(/No folders yet/i)).toBeInTheDocument();
  });
});
