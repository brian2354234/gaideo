import React, { useEffect, useRef, useState } from 'react';
import { useConnect } from '@blockstack/connect';
import Hls from "hls.js";
import "../browse-videos/BrowseVideos.css";
import { useParams, useHistory, useLocation } from 'react-router-dom';
import { VideoDescription } from './VideoDescription';
import { getEncryptedFile } from '../../utilities/gaia-utils';
import { getImageSize } from '../../utilities/image-utils';
import { VideosType } from '../../utilities/media-utils';

interface VideoPlayerContext {
  current: any;
}

interface ParamTypes { 
  id: string; 
  owner?: string
}

interface VideoPlayerProps {
  isMobile: boolean
}

export function VideoPlayer(props: VideoPlayerProps) {
  const { authOptions } = useConnect();
  const { userSession } = authOptions;
  const { id, owner } = useParams<ParamTypes>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const history = useHistory();
  const location = useLocation();
  const [width, setWidth] = useState<number | undefined>();
  const [height, setHeight] = useState<number | undefined>();


  useEffect(() => {
    const context: VideoPlayerContext = {
      current: {}
    };
  
    function process(playlist: any) {
      return context.current.videoKey as ArrayBuffer;
    }
    class customLoader extends Hls.DefaultConfig.loader {
  
      constructor(config: any) {
        super(config);
        var load = this.load.bind(this);
        this.load = function (context, config, callbacks) {
          if (context.url.endsWith('key.bin')) {
            var onSuccess = callbacks.onSuccess;
            callbacks.onSuccess = function (response, stats, context) {
              response.data = process(response.data);
              onSuccess(response, stats, context);
            }
          }
          load(context, config, callbacks);
        };
      }
    }
      let hls: Hls | null;
    const playVideo = async () => {
      if (userSession?.isUserSignedIn() && videoRef?.current) {
        let userData = userSession.loadUserData();
        let userName: string | undefined = undefined;
        if (owner && owner !== userData.username) {
          userName = owner;
        }
        let videoKey = await getEncryptedFile(userSession, `videos/${id}/key.bin`, id, VideosType, userName);
        if (videoKey) {
          context.current.videoKey = videoKey;

          const widthRegex = /width=([0-9]{3,5})/g
          const heightRegex = /height=([0-9]{3,5})/g
          const heightResult = heightRegex.exec(location.search);
          if (heightResult?.length === 2) {
            const widthResult = widthRegex.exec(location.search);
            if (widthResult?.length === 2) {
              const size = getImageSize(parseInt(widthResult[1]), parseInt(heightResult[1]), 1280, 720);
              setWidth(size[0]);
              setHeight(size[1]);

            }
          }

          if (Hls.isSupported()) {
            let source = await userSession.getFileUrl(`videos/${id}/master.m3u8`, {
              username: userName
            })
            if (source) {
              hls = new Hls({
                loader: customLoader
              });

              hls.loadSource(source);
              hls.attachMedia(videoRef.current);
              hls.on(Hls.Events.MANIFEST_PARSED, function () {
                if (videoRef.current) {
                  let playPromise = videoRef.current.play();
                  if (playPromise !== undefined) {
                    playPromise.then((_: any) => {
                    })
                      .catch((error: any) => {
                      });
                  }
                }
              });
            }
            else {
              history.push('/');
            }

          }
          else {
            let source = await userSession.getFileUrl(`videos/${id}/master.m3u8`)
            if (source) {
              videoRef.current.src = source;
            }
          }
        }
        else {
          history.push('/');
        }
      }
    }

    playVideo();
    return function cleanup() {
      if (hls) {
        hls.destroy();
      }
    }
  }, [userSession, location.search, history, id, owner]);


  return (
    <div style={{ paddingLeft: props.isMobile ? 0 : 22 }}>
      <video 
        ref={videoRef} 
        id="video" 
        width="100%" 
        style={{ maxWidth: width, maxHeight: height }} 
        controls></video>
      <VideoDescription />
    </div>);
}
