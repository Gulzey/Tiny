/** Background windows retain data/audio but postpone expensive UI rendering. */
export function createActivityPolicy(
  onChange: (active: boolean) => void,
  source: Document = document,
  view: Window = window,
) {
  let nativeActive: boolean | undefined;
  let active = !source.hidden && source.hasFocus();
  source.documentElement.dataset.activity = active
    ? 'foreground'
    : 'background';
  const update = () => {
    const next = nativeActive ?? (!source.hidden && source.hasFocus());
    if (next === active) return;
    active = next;
    source.documentElement.dataset.activity = active
      ? 'foreground'
      : 'background';
    onChange(active);
  };
  const nativeUpdate = (event: Event) => {
    const value = (event as CustomEvent<{ active?: boolean }>).detail?.active;
    if (typeof value !== 'boolean') return;
    nativeActive = value;
    update();
  };
  view.addEventListener('tiny-native-activity', nativeUpdate);
  source.addEventListener('visibilitychange', update);
  view.addEventListener('focus', update);
  view.addEventListener('blur', update);
  return {
    get active() {
      return active;
    },
    dispose() {
      view.removeEventListener('tiny-native-activity', nativeUpdate);
      source.removeEventListener('visibilitychange', update);
      view.removeEventListener('focus', update);
      view.removeEventListener('blur', update);
    },
  };
}
