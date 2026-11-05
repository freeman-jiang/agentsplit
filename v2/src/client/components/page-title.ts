import { useEffect } from 'react'

const DEFAULT_TITLE = 'AgentSplit · Shared expenses, simply settled'

/** Sets the document title as "<title> · AgentSplit", and restores the default on leave. */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · AgentSplit`
    return () => {
      document.title = DEFAULT_TITLE
    }
  }, [title])
}
