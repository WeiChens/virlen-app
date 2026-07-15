import { IProvider } from '@/infrastructure/provider/types'
import { Session } from '@/types'

export interface ProviderPort {
  register(id: string, provider: IProvider): Promise<void>
  unregister(id: string): Promise<boolean>
  get(id: string): Promise<IProvider | undefined>
  getDefault(): Promise<IProvider | undefined>
  list(): Promise<{ id: string; name: string }[]>

  ensureProvider(session: Session): Promise<IProvider>
}
