export class Profile {
  #name = 'ada';

  /** This was a method once. Spying on it now needs an access type. */
  get displayName(): string {
    return this.#name;
  }

  rename(next: string): void {
    this.#name = next;
  }
}
