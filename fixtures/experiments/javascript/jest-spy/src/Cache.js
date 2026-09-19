export class Cache {
  get(key) {
    return key.length > 0 ? 'value' : null;
  }
}
