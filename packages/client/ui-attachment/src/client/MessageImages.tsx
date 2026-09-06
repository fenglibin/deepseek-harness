import type { MessageImagesProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { InlineMessageImage } from '../InlineMessageImage.tsx'
import { messageImageLabels } from './labels.ts'

/** Historical message-image slot entry: inline thumbnails that flow with the text. */
export function MessageImages({ images, loadImage, t }: MessageImagesProps) {
  const labels = messageImageLabels(t)
  return (
    <>
      {images.map((image, index) => (
        <InlineMessageImage
          key={`${'attachment' in image ? image.attachment.attachmentId : image.preview.url}:${index}`}
          image={image}
          load={loadImage}
          labels={labels}
        />
      ))}
    </>
  )
}
