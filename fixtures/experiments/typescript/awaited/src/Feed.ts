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
}
