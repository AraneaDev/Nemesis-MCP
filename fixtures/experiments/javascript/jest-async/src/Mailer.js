export class Mailer {
  async send(to) {
    return { accepted: to.length > 0 };
  }
}
