import { describe, it, expect } from 'vitest';
import { canEdit } from '../src/services/access.service.js';

describe('access.service · canEdit', () => {
  it('grants edit to owner, admin and edit-level', () => {
    expect(canEdit('owner')).toBe(true);
    expect(canEdit('admin')).toBe(true);
    expect(canEdit('edit')).toBe(true);
  });

  it('denies edit to view-only and no access', () => {
    expect(canEdit('view')).toBe(false);
    expect(canEdit(null)).toBe(false);
    expect(canEdit(undefined)).toBe(false);
  });
});
