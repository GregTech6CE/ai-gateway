import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from '../src/index.ts';

describe('workspace', () => {
  it('imports the package entry', () => {
    expect(PACKAGE_NAME).toBe('@gt6ce/core');
  });
});
