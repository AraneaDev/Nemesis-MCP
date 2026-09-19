export enum Channel {
  Email = 'email',
  Push = 'push',
}

export class Feed {
  /** This used to be async. The stub below still believes it is. */
  latest(): string {
    return 'item';
  }

  channel(): Channel {
    return Channel.Email;
  }

  /** This used to throw asynchronously, and used to be fluent. */
  retry(): boolean {
    return true;
  }

  next(): string {
    return '';
  }
}
