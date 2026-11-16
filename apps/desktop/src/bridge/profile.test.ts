import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { profileDirsOf } from './profile';
import { PROFILE_ENV } from './protocol';

const home = 'C:\\Users\\someone';
const roaming = 'D:\\roaming';
const usual = ['RulZ Kinspora', 'RulZ Ancestry', 'RulZ Kinspora (dev)', 'RulZ Ancestry (dev)'].map(
  (name) => join(roaming, name),
);

describe('where the bridge looks for the file of the app', () => {
  it('is the folder of an installed copy, then that of a copy started from the source code', () => {
    expect(profileDirsOf({ APPDATA: roaming }, home)).toEqual(usual);
    const inHome = join(home, 'AppData', 'Roaming');
    expect(profileDirsOf({}, home)).toEqual([
      ...['RulZ Kinspora', 'RulZ Ancestry', 'RulZ Kinspora (dev)', 'RulZ Ancestry (dev)'].map(
        (name) => join(inHome, name),
      ),
    ]);
    expect(profileDirsOf({ APPDATA: '' }, home)).toEqual(profileDirsOf({}, home));
  });

  it('is the folder it was told, and no other', () => {
    const told = 'E:\\somewhere\\data';
    expect(profileDirsOf({ [PROFILE_ENV]: told, APPDATA: roaming }, home)).toEqual([told]);
    expect(profileDirsOf({ [PROFILE_ENV]: `  ${told} `, APPDATA: roaming }, home)).toEqual([told]);
    expect(profileDirsOf({ RULZ_ANCESTRY_PROFILE: told }, home)).toEqual([told]);
    expect(profileDirsOf({ [PROFILE_ENV]: told, RULZ_ANCESTRY_PROFILE: 'E:\\old' }, home)).toEqual([
      told,
    ]);
  });

  it('takes no setting that was left empty for a folder', () => {
    for (const empty of ['', '   ', '${user_config.data_folder}', 'undefined', 'data', '.\\data']) {
      expect(profileDirsOf({ [PROFILE_ENV]: empty, APPDATA: roaming }, home)).toEqual(usual);
    }
  });
});
