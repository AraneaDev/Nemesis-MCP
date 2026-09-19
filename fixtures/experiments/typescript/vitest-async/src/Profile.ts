export interface Profile {
  id: string;
}

export class ProfileService {
  async load(id: string): Promise<Profile> {
    return { id };
  }
}
