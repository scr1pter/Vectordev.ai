import * as storage from "../upload/storage"

export async function saveAvatar(user: string, image: Uint8Array) {
  return storage.storeObject(`avatars/${user}`, image)
}
