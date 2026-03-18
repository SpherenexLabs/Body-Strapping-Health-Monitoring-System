import { initializeApp } from 'firebase/app'
import { getDatabase, push, ref, set } from 'firebase/database'

const firebaseConfig = {
  apiKey: 'AIzaSyB9erNsNonAzH0zQ_GS79XP0yCoMxr4',
  authDomain: 'waterdtection.firebaseapp.com',
  databaseURL: 'https://waterdtection-default-rtdb.firebaseio.com',
  projectId: 'waterdtection',
  storageBucket: 'waterdtection.firebasestorage.app',
  messagingSenderId: '690886375729',
  appId: '1:690886375729:web:172c3a47dda6585e4e1810',
  measurementId: 'G-TXF33Y6XY0',
}

const app = initializeApp(firebaseConfig)

export const db = getDatabase(app)

export const BODY_PATH = 'Body_Strapping'

export function getBodyRef() {
  return ref(db, BODY_PATH)
}

export async function setSosButtonActive() {
  await set(ref(db, `${BODY_PATH}/Button`), 1)
}

export async function setSosButtonValue(value) {
  await set(ref(db, `${BODY_PATH}/Button`), value)
}

export async function logEvent(event) {
  const eventsRef = ref(db, `${BODY_PATH}/Events`)
  await push(eventsRef, event)
  await set(ref(db, `${BODY_PATH}/LastEvent`), event)
}