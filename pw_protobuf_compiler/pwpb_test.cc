// Copyright 2022 The Pigweed Authors
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not
// use this file except in compliance with the License. You may obtain a copy of
// the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
// License for the specific language governing permissions and limitations under
// the License.

#include "gtest/gtest.h"
#include "pw_protobuf_compiler_pwpb_protos/pwpb_test.pwpb.h"

TEST(Pwpb, CompilesProtobufs) {
  pw::protobuf_compiler::Point::Message point = {4, 8, "point"};
  EXPECT_EQ(point.x, 4u);
  EXPECT_EQ(point.y, 8u);
  EXPECT_EQ(point.name.size(), 5u);
  EXPECT_EQ(point.name, "point");
}
