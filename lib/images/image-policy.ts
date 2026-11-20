export const IMAGE_SAFETY_POLICY = 'wildnews-no-weapons-v1';

// Keep known rejected assets blocked even if their captions are later removed.
const blockedAssets = ['photo-1609259927325-e0812535ed96', 'DbUjHixYXfQ', 'photo-1535253868107-da56da1693db', 'uuFZHr_nRWY'];
const weapons = /\b(?:weapons?|firearms?|guns?|handguns?|shotguns?|rifles?|pistols?|revolvers?|ammunition|munitions|grenades?|missiles?|bayonets?|knives|knife|daggers?|machetes?|swords?|sabres?|sabers?|crossbows?|assault[- ]rifles?|machine[- ]guns?|rocket[- ]launchers?|combat[- ]axes?|battle[- ]axes?)\b/i;

export function imageWeaponReason(values: Array<string | null | undefined>): string | null {
  const text = values.filter(Boolean).join(' ').replace(/scimitar[- ]horned|sword[- ]billed|saber[- ]toothed|sabre[- ]toothed/gi, 'animal');
  if (blockedAssets.some((asset) => text.includes(asset))) return 'This image is on the rejected weapon-image list.';
  return weapons.test(text) ? 'The image description or attribution identifies weapon imagery.' : null;
}

export function isTrustedEditorialFallback(value: string): boolean {
  return value === '/editorial-image-fallback.png' || value === 'https://news.wildteam.org.uk/editorial-image-fallback.png';
}
