import { useEffect, useState } from 'react'

export const useTime = (ms = 1000) => {
  const [time, setTime] = useState(new Date())
  useEffect(() => {
    const interval = setInterval(() => {
      setTime(new Date())
    }, ms)
    return () => {
      clearInterval(interval)
    }
  }, [])
  return time
}

export default useTime
