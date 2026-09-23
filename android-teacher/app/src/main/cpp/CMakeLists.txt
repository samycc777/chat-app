cmake_minimum_required(VERSION 3.22.1)
project(teachervoice C)

# RNNoise 0.2 from the xiph/rnnoise release tarball
# (https://github.com/xiph/rnnoise/releases/download/v0.2/rnnoise-0.2.tar.gz), with its trained
# model built in. BSD-3-Clause; see rnnoise/COPYING. The release does not compile for ARM, so
# upstream's fix from the following commit is applied: 372f7b4 "Fix compilation errors".
set(RNNOISE ${CMAKE_CURRENT_SOURCE_DIR}/rnnoise)

add_library(teachervoice SHARED
  teacher_voice.c
  ${RNNOISE}/src/denoise.c
  ${RNNOISE}/src/rnn.c
  ${RNNOISE}/src/pitch.c
  ${RNNOISE}/src/kiss_fft.c
  ${RNNOISE}/src/celt_lpc.c
  ${RNNOISE}/src/nnet.c
  ${RNNOISE}/src/nnet_default.c
  ${RNNOISE}/src/parse_lpcnet_weights.c
  ${RNNOISE}/src/rnnoise_data.c
  ${RNNOISE}/src/rnnoise_tables.c
)
target_include_directories(teachervoice PRIVATE ${RNNOISE}/include ${RNNOISE}/src)
# Only the JNI functions are exported. The filter runs every 10 ms on the audio thread, so it is
# built for speed even in debug builds.
target_compile_options(teachervoice PRIVATE -O3 -fvisibility=hidden -Wno-unused-function)
# Android 15 devices with 16 KB memory pages refuse libraries aligned for 4 KB pages.
target_link_options(teachervoice PRIVATE -Wl,-z,max-page-size=16384)
target_link_libraries(teachervoice m)
