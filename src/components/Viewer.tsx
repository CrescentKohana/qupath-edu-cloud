import { fetchSlide } from "lib/api";
import { overlayState, selectedAnnotationState, viewportState } from "lib/atoms";
import { area, centroid, clamp } from "lib/helpers";
import OpenSeadragon from "openseadragon";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { useRecoilState, useSetRecoilState } from "recoil";
import "styles/Viewer.css";
import { Annotation, LineString, Polygon } from "types";
import { sha1 } from "object-hash";

interface ViewerProps {
    slideId?: string | null;
    annotations?: Annotation[];
}

function Viewer({ slideId, annotations }: ViewerProps) {
    const [selectedAnnotation, setSelectedAnnotation] = useRecoilState(selectedAnnotationState);
    const [viewport, setViewport] = useState<OpenSeadragon.Viewport>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [overlay, setOverlay] = useState<any>();
    const [viewer, setViewer] = useState<OpenSeadragon.Viewer | null>(null);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        if (selectedAnnotation) {
            PanToAnnotation(selectedAnnotation);
            ZoomToAnnotation(selectedAnnotation);
            HighlightAnnotation(selectedAnnotation);
        }
    }, [selectedAnnotation]);

    const PanToAnnotation = (annotation: Annotation) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const screenWidth = (viewport as any)._contentSize.x;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const screenHeight = (viewport as any)._contentSize.y;

        const centre = centroid(annotation.geometry, screenWidth, screenHeight);
        viewport?.panTo(centre);
    }

    // TODO: This doesn't work on very large or small annotations, but clamping the zoom partially fixes this.
    const ZoomToAnnotation = (annotation: Annotation) => {
        if (!viewport) return;

        const annotationArea = area(annotation.geometry);
        const slideArea = viewport.getContainerSize().x * viewport.getContainerSize().y;

        const MaxZoom = viewport.getMaxZoom();
        const MinZoom = viewport.getMinZoom();
        const NewZoom = viewport.imageToViewportZoom(slideArea / annotationArea);

        viewport.zoomTo(clamp(NewZoom, MinZoom, MaxZoom));
    }

    const HighlightAnnotation = (annotation: Annotation) => {
        const SelectedAnnotationHash = sha1(annotation.geometry.coordinates[0]);

        // First remove any highlight by removing the `selected--annotation` class from every annotation
        window.d3
            .select(overlay.node())
            .selectAll(".annotation")
            .classed("selected--annotation", false)

        // Now add the `selected--annotation` class to our selected annotation
        window.d3
            .select(overlay.node())
            .selectAll(".annotation")
            .filter(function(d) { 
                // Check that we have valid data
                if (Array.isArray(d)) {
                    const CurrentAnnotationHash = sha1(d);

                    return SelectedAnnotationHash == CurrentAnnotationHash;
                } 

                return false 
            })
            .classed("selected--annotation", true);
    };

    useEffect(() => {
        const viewer = window.OpenSeadragon({
            id: "Viewer",
            prefixUrl: "assets/images/",
            defaultZoomLevel: 0,
            //debugMode: process.env.NODE_ENV !== "production",
            showNavigator: true,
            navigatorSizeRatio: 0.15,
            navigatorAutoFade: false,
            showNavigationControl: false,
            gestureSettingsMouse: {
                clickToZoom: false,
                dblClickToZoom: true,
            },
        });

        setViewer(viewer);
    }, []);

    useEffect(() => {
        drawViewer();
    }, [slideId]);

    useEffect(() => {
        // Without this the Viewer is not rendered if the user selects a slide prior to opening the Viewer tab, the viewer
        drawViewer();
    }, [viewer]);

    function drawViewer() {
        if (!slideId || !viewer || !annotations) {
            return;
        }

        // TODO: Refactor this to its own class/functions etc.
        const apiHelper = async () => {
            const result = await fetchSlide(slideId);

            const downsamples: number[] = [];
            const levelCount = parseInt(result["openslide.level-count"]);

            const slideHeight = parseInt(result["openslide.level[0].height"]);
            const slideWidth = parseInt(result["openslide.level[0].width"]);

            const tileHeight = parseInt(result["openslide.level[0].tile-width"]);
            const tileWidth = parseInt(result["openslide.level[0].tile-height"]);

            for (let i = 0; i < levelCount; i++) {
                downsamples.push(Math.floor(parseInt(result["openslide.level[" + i + "].downsample"])));
            }

            viewer.open({
                height: slideHeight,
                width: slideWidth,
                tileHeight: tileHeight,
                tileWidth: tileWidth,
                minLevel: 0,
                maxLevel: levelCount - 1,
                getLevelScale: function (level: number) {
                    return 1 / downsamples[levelCount - level - 1];
                },
                getTileUrl: function (level: number, x: number, y: number) {
                    level = levelCount - level - 1;

                    const downsample = downsamples[level];

                    let adjustY = 0;
                    let adjustX = 0;

                    const tileY = y * tileHeight * downsample;
                    const tileX = x * tileWidth * downsample;

                    if (tileX + downsample * tileWidth > slideWidth) {
                        adjustX = tileWidth - Math.floor(Math.abs((tileX - slideWidth) / downsample));
                    }

                    if (tileY + downsample * tileHeight > slideHeight) {
                        adjustY = tileHeight - Math.floor(Math.abs((tileY - slideHeight) / downsample));
                    }

                    const height = tileHeight - adjustY;
                    const width = tileWidth - adjustX;

                    return result["openslide.remoteserver.uri"]
                        .replace("{tileX}", String(tileX as unknown))
                        .replace("{tileY}", String(tileY as unknown))
                        .replace("{level}", String(level as unknown))
                        .replace("{tileWidth}", String(width as unknown))
                        .replace("{tileHeight}", String(height as unknown));
                },
            });

            // This could also be openslide.mpp-x or openslide.mpp-y
            // TODO: Create fallback aperio.MPP does not exist
            const mpp = parseFloat(result["aperio.MPP"]);

            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            viewer.scalebar({
                xOffset: 10,
                yOffset: 10,
                barThickness: 3,
                color: "#555555",
                fontColor: "#333333",
                backgroundColor: "rgba(255, 255, 255, 0.5)",
                pixelsPerMeter: mpp ? 1e6 / mpp : 0,
            });

            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const overlay = viewer.svgOverlay();

            // Clear any annotations from a previous slide
            window.d3.select(overlay.node()).selectAll("*").remove();

            Array.from(annotations).forEach((annotation) => {
                if (annotation.geometry.type === "LineString") {
                    drawLine(annotation);
                } else if (annotation.geometry.type === "Polygon") {
                    drawPolygon(annotation);
                } else {
                    console.log(`${annotation.geometry.type} geometry type not implemented.`);
                }
            });

            function drawLine(annotation: Annotation) {
                const coordinates = annotation.geometry.coordinates as LineString;

                window.d3
                    .select(overlay.node())
                    .append("line")
                    .attr("id", sha1(coordinates))
                    .attr("class", "annotation")
                    .data(coordinates)
                    .style("stroke", "#f00")
                    .attr("x1", scaleX(coordinates[0][0]))
                    .attr("y1", scaleY(coordinates[0][1]))
                    .attr("x2", scaleX(coordinates[1][0]))
                    .attr("y2", scaleY(coordinates[1][1]))
                    .on("click", () => { setSelectedAnnotation(annotation) });
            }

            function drawPolygon(annotation: Annotation) {
                const coordinates = annotation.geometry.coordinates as Polygon;
                
                window.d3
                    .select(overlay.node())
                    .append("polygon")
                    .attr("id", sha1(coordinates))
                    .attr("class", "annotation")
                    .data(coordinates)
                    .style("stroke", "#f00")
                    .style("fill", "transparent")
                    .attr("points", function () {
                        return coordinates[0]
                            .map(function (point: number[]) {
                                return [scaleX(point[0]), scaleY(point[1])].join(",");
                            })
                            .join(" ");
                    })
                    .on("click", () => { setSelectedAnnotation(annotation) });
            }

            function scaleX(x: number) {
                return x / slideWidth;
            }

            function scaleY(y: number) {
                // For some reason we need to multiply the y-coordinate by the ratio of the height and width.
                // This is not necessary for the x-coordinate for some reason.
                // This requires some further investigation into why this happens.
                return (y / slideHeight) * (slideHeight / slideWidth);
            }

            // 0.001 is the default size for stroke thickness as defined in Viewer.css
            const ScalingFactor = 0.001 / viewer.viewport.getMinZoom();

            viewer.addHandler('zoom', function (viewer) {
                // Thickness = ScalingFactor * Inverse Zoom
                const thickness = ScalingFactor * (1 / (viewer.zoom ?? 1));
                document.documentElement.style.setProperty(`--stroke-thickness`, String(thickness));
            })

            overlay.resize();
            setViewport(viewer.viewport);
            setOverlay(overlay);
        };

        apiHelper().catch((e) => {
            setViewer(null);
            if (e instanceof Error) {
                setError(e);
                toast.error(e.message);
            }
        });
    }

    if (error) {
        return <p>Unexpected error with Viewer</p>;
    }

    return <div id="Viewer" className="h-full w-full bg-black" />;
}

export default Viewer;
