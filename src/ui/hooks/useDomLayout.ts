import { useEffect, useState } from "react";


const getDomLayout = (ref: React.RefObject<HTMLElement>) => {
    if (!ref.current) return null;
    const rect = ref.current.getBoundingClientRect();
    return rect
}

export const useDomRect = (ref: React.RefObject<HTMLElement>) => {
    const [domRect, setDomRect] = useState<DOMRect>(null);
    const handleResize = () => {
        const rect = getDomLayout(ref);
        setDomRect(rect);
    };
    useEffect(() => {
        handleResize();
        window.addEventListener('resize', handleResize);
        return () => {
            window.removeEventListener('resize', handleResize);
        };
    }, [ref]);

    return [domRect,handleResize] as const;
}