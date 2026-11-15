import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { profileDirOf } from './profile';
import { PROFILE_ENV } from './protocol';

const home = 'C:\\Users\\someone';
const roaming = 'D:\\roaming';

describe('where the bridge looks for the file of the app', () => {
  it('is the folder of an installed copy when nothing tells it otherwise', () => {
    expect(profileDirOf({ APPDATA: roaming }, home)).toBe(join(roaming, 'RulZ Ancestry'));
    expect(profileDirOf({}, home)).toBe(join(home, 'AppData', 'Roaming', 'RulZ Ancestry'));
    expect(profileDirOf({ APPDATA: '' }, home)).toBe(
      join(home, 'AppData', 'Roaming', 'RulZ Ancestry'),
    );
  });

  it('is the folder it was told', () => {
    const told = 'C:\\Users\\someone\\AppData\\Roaming\\RulZ Ancestry (dev)';
    expect(profileDirOf({ [PROFILE_ENV]: told, APPDATA: roaming }, home)).toBe(told);
    expect(profileDirOf({ [PROFILE_ENV]: `  ${told} `, APPDATA: roaming }, home)).toBe(told);
  });

  it('takes no setting that was left empty for a folder', () => {
    const usual = join(roaming, 'RulZ Ancestry');
    for (const empty of ['', '   ', '${user_config.data_folder}', 'undefined', 'data', '.\\data']) {
      expect(profileDirOf({ [PROFILE_ENV]: empty, APPDATA: roaming }, home)).toBe(usual);
    }
  });
});
