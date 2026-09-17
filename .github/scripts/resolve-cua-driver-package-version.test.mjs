import assert from 'node:assert/strict';
import { test } from 'vitest';
import { selectCuaDriverPackageVersion } from './resolve-cua-driver-package-version.mjs';

test('keeps Cua Driver platform packages on their own patch version line', () => {
  const releases = [
    { version: '0.1.0', cuaDriverVersion: 'previous-driver' },
    { version: '9.9.9', cuaDriverVersion: 'current-driver' },
  ];

  assert.equal(selectCuaDriverPackageVersion('0.1.0', 'current-driver', releases), '0.1.1');
  assert.equal(
    selectCuaDriverPackageVersion('0.1.0', 'current-driver', [
      ...releases,
      { version: '0.1.1', cuaDriverVersion: 'current-driver' },
    ]),
    '0.1.1',
  );
  assert.equal(
    selectCuaDriverPackageVersion('0.1.0', 'next-driver', [
      ...releases,
      { version: '0.1.1', cuaDriverVersion: 'current-driver' },
    ]),
    '0.1.2',
  );
});
