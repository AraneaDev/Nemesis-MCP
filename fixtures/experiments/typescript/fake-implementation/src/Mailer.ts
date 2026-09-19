export class Mailer {
  send(to: string): boolean {
    return to.length > 0;
  }

  retry(attempt: number): boolean {
    return attempt < 3;
  }
}
