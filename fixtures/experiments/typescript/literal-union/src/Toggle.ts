export class Toggle {
  /** 'auto' was removed from the union; the string still parses. */
  mode(): 'on' | 'off' {
    return 'on';
  }

  retries(): 1 | 2 | 3 {
    return 1;
  }
}
