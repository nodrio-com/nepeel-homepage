import { memo, useState } from "react";
import { Image as NativeImage, StyleSheet, View } from "react-native";
import { Canvas, ColorMatrix, Image, type SkImage } from "@shopify/react-native-skia";
import { PHOTO_FILTERS, type PhotoFilter, type TapePosition } from "../shared/capture-context";
import { PhotoTape } from "./PhotoTape";

interface FilteredPhotoProps {
  uri: string;
  image: SkImage | null;
  filter: PhotoFilter;
  thumbnail?: boolean;
  tape?: TapePosition;
}

export default memo(function FilteredPhoto({ uri, image, filter, thumbnail, tape }: FilteredPhotoProps) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const scale = image ? Math.min(size.width / image.width(), size.height / image.height()) : 0;
  const width = image && !thumbnail ? image.width() * scale : size.width;
  const height = image && !thumbnail ? image.height() * scale : size.height;
  const fit = thumbnail ? "cover" : "contain";

  return (
    <View
      style={styles.container}
      onLayout={({ nativeEvent: { layout } }) => setSize(current =>
        current.width === layout.width && current.height === layout.height
          ? current
          : { width: layout.width, height: layout.height },
      )}
    >
      {image && width > 0 && height > 0 ? (
        <View style={{ width, height }}>
          <Canvas style={StyleSheet.absoluteFill}>
            <Image image={image} x={0} y={0} width={width} height={height} fit={fit}>
              <ColorMatrix matrix={[...PHOTO_FILTERS[filter].matrix]} />
            </Image>
          </Canvas>
          {tape && <PhotoTape position={tape} frameWidth={width} frameHeight={height} />}
        </View>
      ) : (
        <NativeImage source={{ uri }} style={StyleSheet.absoluteFill} resizeMode={fit} />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#20221d" },
});
