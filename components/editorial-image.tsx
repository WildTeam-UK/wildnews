'use client';

/* oxlint-disable next/no-img-element -- remote editorial images use native error handling so a local brand fallback can replace failed provider images */

import { useState, type ImgHTMLAttributes } from 'react';
import { imageWeaponReason, isTrustedEditorialFallback } from '@/lib/images/image-policy';

type EditorialImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> & {
  src: string;
};

const FALLBACK_IMAGE = '/editorial-image-fallback.png';

export function EditorialImage({ alt, className, src, ...props }: EditorialImageProps) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const showingFallback = failedSource === src || Boolean(imageWeaponReason([src, alt])) || isTrustedEditorialFallback(src);

  return <img
    {...props}
    alt={showingFallback ? '' : alt}
    className={[className, showingFallback ? 'editorial-image-fallback' : ''].filter(Boolean).join(' ')}
    src={showingFallback ? FALLBACK_IMAGE : src}
    onError={() => {
      if (!showingFallback) setFailedSource(src);
    }}
  />;
}
